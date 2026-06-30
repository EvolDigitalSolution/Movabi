import { NextFunction, Request, Response, Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import {
  checkVehicleRegistration,
  checkInsurance,
  checkCouncilLicence
} from '../services/verification.service';
import { NotificationService } from '../services/notification.service';

const router = Router();

const parseVerificationItems = (value: unknown): Record<string, unknown> => {
  if (!value) return {};

  if (Array.isArray(value)) {
    return value.reduce<Record<string, unknown>>((items, entry) => {
      if (!entry || typeof entry !== 'object') return items;
      const record = entry as Record<string, unknown>;
      const key = String(record.key || record.name || record.field || '').trim();
      if (key) items[key] = record.value ?? record.label ?? '';
      return items;
    }, {});
  }

  if (typeof value === 'object') return value as Record<string, unknown>;

  if (typeof value === 'string') {
    try {
      return parseVerificationItems(JSON.parse(value));
    } catch {
      return {};
    }
  }

  return {};
};

const parseServiceTypes = (value: unknown): string[] => {
  const values = Array.isArray(value) ? value : [value];
  const flattened = values.flatMap((item) => {
    if (Array.isArray(item)) return item;
    if (typeof item === 'string') {
      try {
        const parsed = JSON.parse(item);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        return item.split(',');
      }
    }
    return [item];
  });

  return Array.from(new Set(flattened
    .map((item) => String(item || '').trim().toLowerCase())
    .map((item) => item === 'van-moving' || item === 'moving' ? 'van' : item)
    .map((item) => item === 'package' || item === 'package_delivery' ? 'delivery' : item)
    .filter(Boolean)));
};

const driverSelectedRide = (profile: any, vehicle: any): boolean => {
  const items = parseVerificationItems(profile?.verification_items);
  const selected = parseServiceTypes([
    vehicle?.service_eligibility,
    items.driver_service_types
  ]);

  if (!selected.length) {
    const vehicleClass = String(items.vehicle_class || vehicle?.capacity || '').toLowerCase();
    return vehicleClass.includes('xl') || vehicleClass.includes('standard');
  }

  return selected.includes('ride');
};

const getVehiclePlate = (vehicle: any): string => String(
  vehicle?.license_plate ??
  vehicle?.registration_plate ??
  vehicle?.registration_number ??
  vehicle?.plate_number ??
  vehicle?.vehicle_registration ??
  ''
).trim();

const supabaseUrl =
  process.env.SUPABASE_URL ||
  process.env.SUPABASE_PUBLIC_URL ||
  'http://movabi-supabase-kong:8000';

const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SERVICE_ROLE_KEY ||
  '';

const supabase = createClient(supabaseUrl, serviceRoleKey);

const requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
  if (!serviceRoleKey) {
    return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not configured.' });
  }

  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();

  if (!token) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const { data: authData, error: authError } = await supabase.auth.getUser(token);

  if (authError || !authData.user?.id) {
    return res.status(401).json({ error: 'Invalid or expired session.' });
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', authData.user.id)
    .maybeSingle();

  if (profileError || profile?.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator access required.' });
  }

  return next();
};

router.use(requireAdmin);

router.post('/drivers/:driverId/preverify', async (req, res) => {
  try {
    if (!serviceRoleKey) {
      return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not configured.' });
    }

    const { driverId } = req.params;

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', driverId)
      .single();

    if (profileError || !profile) {
      return res.status(404).json({ error: 'Driver profile not found.' });
    }

    const { data: vehicle } = await supabase
      .from('vehicles')
      .select('*')
      .eq('driver_id', driverId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const blockers: string[] = [];

    const vehiclePlate = getVehiclePlate(vehicle);
    const vehicleCheck = await checkVehicleRegistration(vehiclePlate);

    if (!vehicleCheck.passed) {
      blockers.push(...vehicleCheck.blockers);
    }

    const insuranceCheck = await checkInsurance();

    if (!profile.insurance_url) {
      blockers.push('Insurance document is missing.');
    } else {
      blockers.push('Insurance document requires manual admin review.');
    }

    const rideSelected = driverSelectedRide(profile, vehicle);
    const councilCheck = rideSelected
      ? await checkCouncilLicence({
          councilName: profile.council_name,
          councilLicenseNumber: profile.council_license_number,
          taxiBadgeNumber: profile.taxi_badge_number,
          taxiLicenseExpiry: profile.taxi_license_expiry
        })
      : { status: 'not_required', blockers: [] as string[] };

    if (rideSelected) {
      blockers.push(...councilCheck.blockers);
    }

    if (!profile.driver_license_url) {
      blockers.push('Driver licence document is missing.');
    }

    if (vehicle && !String(vehicle.make || '').trim()) blockers.push('Vehicle make is missing.');
    if (vehicle && !String(vehicle.model || '').trim()) blockers.push('Vehicle model is missing.');
    if (vehicle && !String(vehicle.color || '').trim()) blockers.push('Vehicle colour is missing.');
    if (vehicle && !String(vehicle.year || '').trim()) blockers.push('Vehicle year is missing.');

    const canApprove =
      vehicleCheck.passed &&
      !!profile.driver_license_url &&
      !!profile.insurance_url &&
      (
        !rideSelected ||
        (
          !!profile.council_name &&
          !!profile.council_license_number &&
          !!profile.taxi_badge_number &&
          !!profile.taxi_license_expiry
        )
      );

    if (vehicle) {
      await supabase
        .from('vehicles')
        .update({
          dvla_make: vehicleCheck.data?.make || null,
          dvla_colour: vehicleCheck.data?.colour || null,
          dvla_tax_status: vehicleCheck.data?.taxStatus || null,
          dvla_mot_status: vehicleCheck.data?.motStatus || null,
          mot_expiry_date: vehicleCheck.data?.motExpiryDate || null,
          vehicle_verified: vehicleCheck.passed,
          last_vehicle_check_at: new Date().toISOString()
        })
        .eq('id', vehicle.id);
    }

    await supabase
      .from('profiles')
      .update({
        vehicle_check_status: vehicleCheck.status,
        mot_check_status: vehicleCheck.status,
        insurance_check_status: insuranceCheck.status,
        council_check_status: councilCheck.status,
        verification_blockers: blockers,
        verification_status: canApprove ? 'ready_for_admin_review' : 'action_required',
        updated_at: new Date().toISOString()
      })
      .eq('id', driverId);

    return res.json({
      canApprove,
      blockers,
      checks: {
        vehicle: vehicleCheck,
        insurance: insuranceCheck,
        council: councilCheck
      }
    });
  } catch (error: any) {
    return res.status(500).json({
      error: error?.message || 'Pre-verification failed.'
    });
  }
});

router.post('/drivers/:driverId/request-info', async (req, res) => {
  try {
    if (!serviceRoleKey) {
      return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not configured.' });
    }

    const { driverId } = req.params;
    const { notes, blockers } = req.body || {};
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    const { data: authData } = await supabase.auth.getUser(token);
    const adminId = authData.user?.id || null;

    const selectedBlockers = Array.isArray(blockers)
      ? blockers.map((item) => String(item || '').trim()).filter(Boolean)
      : [];

    if (!selectedBlockers.length && !String(notes || '').trim()) {
      return res.status(400).json({ error: 'Add at least one blocker or review note before sending.' });
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('driver_review_history')
      .eq('id', driverId)
      .single();

    if (profileError || !profile) {
      return res.status(404).json({ error: 'Driver profile not found.' });
    }

    const sentAt = new Date().toISOString();
    const previousHistory = Array.isArray(profile.driver_review_history)
      ? profile.driver_review_history
      : [];

    const historyEntry = {
      status: 'action_required',
      notes: String(notes || '').trim(),
      blockers: selectedBlockers,
      sent_at: sentAt,
      sent_by: adminId
    };

    const { error } = await supabase
      .from('profiles')
      .update({
        driver_review_status: 'action_required',
        driver_review_notes: historyEntry.notes,
        driver_review_blockers: selectedBlockers,
        driver_review_sent_at: sentAt,
        driver_review_sent_by: adminId,
        driver_review_history: [...previousHistory, historyEntry].slice(-20),
        verification_status: 'action_required',
        verification_blockers: selectedBlockers,
        verification_notes: historyEntry.notes || null,
        updated_at: sentAt
      })
      .eq('id', driverId);

    if (error) throw error;

    await NotificationService
      .notifyDriverReviewActionRequired(driverId, selectedBlockers, historyEntry.notes)
      .catch((notifyError) => {
        console.warn('[admin-driver-review] notification failed:', notifyError?.message || notifyError);
      });

    return res.json({
      success: true,
      message: 'Missing information request sent to driver.',
      blockers: selectedBlockers
    });
  } catch (error: any) {
    return res.status(500).json({
      error: error?.message || 'Could not send missing information request.'
    });
  }
});

// ===== MANUAL TEST APPROVAL ROUTE =====
router.post('/drivers/:driverId/manual-approve', async (req, res) => {
  try {
    if (!serviceRoleKey) {
      return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY is not configured.' });
    }

    const { driverId } = req.params;
    const { notes, testingOverride } = req.body || {};

    if (!testingOverride) {
      return res.status(400).json({
        error: 'Manual approval requires testingOverride=true'
      });
    }

    const { error } = await supabase
      .from('profiles')
      .update({
        is_verified: true,
        verification_status: 'approved',
        account_status: 'active',
        manual_verification_notes: notes || 'Approved manually (testing override)',
        testing_approval_override: true,
        driver_review_status: 'approved',
        verification_blockers: [],
        updated_at: new Date().toISOString()
      })
      .eq('id', driverId);

    if (error) throw error;

    return res.json({
      success: true,
      message: 'Driver manually approved (testing override)'
    });

  } catch (error: any) {
    return res.status(500).json({
      error: error?.message || 'Manual approval failed.'
    });
  }
});

export default router;

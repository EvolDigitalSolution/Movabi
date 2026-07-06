import { NextFunction, Request, Response, Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { NotificationService } from '../services/notification.service';
import { EmailService } from '../services/email.service';
import {
  getAdminReviewRequirements,
  getBlockingRequirements,
  getDriverRequirements,
  getVehiclePlateValue,
  isRideSelected,
  normaliseSelectedServices,
  normaliseVehicleClass,
  vehicleRequiresRegistration
} from '../shared/driver-requirements.engine';

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

const firstValue = (source: Record<string, unknown> | null | undefined, keys: string[]): string | null => {
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    if (String(value ?? '').trim()) return String(value).trim();
  }
  return null;
};

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

    const selectedServices = normaliseSelectedServices(profile, vehicle);
    const vehicleClass = normaliseVehicleClass(vehicle);
    const { data: authUser } = await supabase.auth.admin.getUserById(driverId);
    const driverProfile = {
      ...profile,
      auth_email: authUser?.user?.email,
      user: authUser?.user
    };
    const driverProfileWithVerificationItems = {
      ...parseVerificationItems(profile.verification_items),
      ...driverProfile
    };
    console.log('[driver-preverify] ride fields', {
      council_name: firstValue(driverProfileWithVerificationItems, ['council_name', 'councilName', 'licensing_authority', 'private_hire_authority', 'council_license_authority']),
      council_license_number: firstValue(driverProfileWithVerificationItems, ['council_license_number', 'councilLicenceNumber', 'council_licence_number', 'private_hire_license_number', 'private_hire_licence_number', 'taxi_licence_number']),
      taxi_badge_number: firstValue(driverProfileWithVerificationItems, ['taxi_badge_number', 'taxiBadgeNumber', 'badge_number', 'driver_badge_number']),
      taxi_license_expiry: firstValue(driverProfileWithVerificationItems, ['taxi_license_expiry', 'taxiLicenceExpiry', 'taxi_licence_expiry', 'private_hire_license_expiry', 'private_hire_licence_expiry', 'private_hire_expiry', 'council_license_expiry']),
      private_hire_vehicle_license_url: firstValue(driverProfileWithVerificationItems, ['private_hire_vehicle_license_url', 'privateHireVehicleLicenseUrl', 'phv_license_url', 'vehicle_license_url', 'private_hire_vehicle_licence_url', 'phv_licence_url'])
    });
    const requirementsInput = {
      countryCode: profile.country_code || profile.country || vehicle?.country_code,
      driver: driverProfile,
      vehicle,
      documents: { ...driverProfile, ...vehicle },
      selectedServices
    };
    const requirements = getDriverRequirements(requirementsInput);
    const blockingRequirements = getBlockingRequirements(requirementsInput);
    const adminReviewRequirements = getAdminReviewRequirements(requirementsInput);
    const blockers = blockingRequirements.map((requirement) => requirement.message);
    const canApprove = blockers.length === 0;
    const rideSelected = isRideSelected(profile, vehicle);
    const vehiclePlate = getVehiclePlateValue(vehicle);
    const registrationRequired = vehicleRequiresRegistration(vehicleClass, selectedServices, profile.country_code);

    if (vehicle) {
      await supabase
        .from('vehicles')
        .update({
          vehicle_verified: registrationRequired ? canApprove && !!vehiclePlate : true,
          last_vehicle_check_at: new Date().toISOString()
        })
        .eq('id', vehicle.id);
    }

    await supabase
      .from('profiles')
      .update({
        vehicle_check_status: registrationRequired ? (vehiclePlate ? 'uploaded' : 'missing') : 'not_required',
        mot_check_status: registrationRequired ? (vehiclePlate ? 'uploaded' : 'missing') : 'not_required',
        insurance_check_status: requirements.find((requirement) => requirement.key.includes('insurance'))?.status || 'missing',
        council_check_status: rideSelected ? (blockers.some((blocker) => blocker.toLowerCase().includes('council') || blocker.toLowerCase().includes('taxi')) ? 'missing' : 'uploaded') : 'not_required',
        verification_blockers: blockers,
        verification_status: canApprove ? 'ready_for_admin_review' : 'action_required',
        updated_at: new Date().toISOString()
      })
      .eq('id', driverId);

    return res.json({
      canApprove,
      blockers,
      requirements,
      adminReviewRequirements,
      checks: {
        vehicle: {
          status: registrationRequired ? (vehiclePlate ? 'uploaded' : 'missing') : 'not_required',
          vehicleClass,
          selectedServices,
          registrationRequired
        },
        insurance: requirements.find((requirement) => requirement.key.includes('insurance')) || null,
        council: {
          status: rideSelected ? 'required' : 'not_required'
        }
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
      .select('driver_review_history, full_name, first_name, last_name, email')
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

    const { data: updatedProfile, error } = await supabase
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
      .eq('id', driverId)
      .select('*')
      .single();

    if (error) throw error;

    await NotificationService
      .notifyDriverReviewActionRequired(driverId, selectedBlockers, historyEntry.notes)
      .catch((notifyError) => {
        console.warn('[admin-driver-review] notification failed:', notifyError?.message || notifyError);
      });

    if (profile.email) {
      const driverName = String(
        profile.full_name ||
        [profile.first_name, profile.last_name].filter(Boolean).join(' ') ||
        ''
      ).trim();

      await EmailService
        .sendDriverReviewActionRequired(profile.email, {
          driverName,
          notes: historyEntry.notes,
          blockers: selectedBlockers
        })
        .catch((emailError) => {
          console.warn('[admin-driver-review] email failed:', emailError?.message || emailError);
        });
    }

    return res.json({
      success: true,
      message: 'Missing information request sent to driver.',
      blockers: selectedBlockers,
      driver: updatedProfile
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

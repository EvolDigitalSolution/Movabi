import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import {
  checkVehicleRegistration,
  checkInsurance,
  checkCouncilLicence
} from '../services/verification.service';

const router = Router();

const supabaseUrl =
  process.env.SUPABASE_URL ||
  process.env.SUPABASE_PUBLIC_URL ||
  'http://movabi-supabase-kong:8000';

const serviceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SERVICE_ROLE_KEY ||
  '';

const supabase = createClient(supabaseUrl, serviceRoleKey);

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

    const vehicleCheck = await checkVehicleRegistration(vehicle?.license_plate);

    if (!vehicleCheck.passed) {
      blockers.push(...vehicleCheck.blockers);
    }

    const insuranceCheck = await checkInsurance();

    if (!profile.insurance_url) {
      blockers.push('Insurance document is missing.');
    } else {
      blockers.push('Insurance document requires manual admin review.');
    }

    const councilCheck = await checkCouncilLicence({
      councilName: profile.council_name,
      councilLicenseNumber: profile.council_license_number,
      taxiBadgeNumber: profile.taxi_badge_number,
      taxiLicenseExpiry: profile.taxi_license_expiry
    });

    blockers.push(...councilCheck.blockers);

    if (!profile.driver_license_url) {
      blockers.push('Driver licence document is missing.');
    }

    const canApprove =
      vehicleCheck.passed &&
      !!profile.driver_license_url &&
      !!profile.insurance_url &&
      !!profile.council_name &&
      !!profile.council_license_number &&
      !!profile.taxi_badge_number &&
      !!profile.taxi_license_expiry;

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

export default router;

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

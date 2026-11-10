import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { canReviewInspection, inspectionSlots } from '../shared/driver-inspection';
import { NextFunction, Request, Response, Router, raw } from 'express';
import { createClient } from '@supabase/supabase-js';
import { NotificationService } from '../services/notification.service';
import { EmailService } from '../services/email.service';
import { DriverRequirementService } from '../services/driver-requirement.service';
import { mapDriverVehicleRow } from '../models/driver-vehicle.model';
import { mapDriverProfile } from '../models/driver-profile.model';
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

  (req as any).adminUserId=authData.user.id;
  return next();
};

const inspectionBucket = 'driver-docs';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function inspectionActor(req: Request) {
  const token = req.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) return null;
  const { data:{user}, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  const { data, error: lookupError } = await supabase.from('profiles')
    .select('id,role,tenant_id').eq('id',user.id).maybeSingle();
  if (lookupError) throw lookupError;
  return data;
}

async function inspectionVehicle(driverId: string) {
  const {data,error} = await supabase.from('vehicles').select('*').eq('user_id',driverId).limit(2);
  if (error) throw error;
  return data.length === 1 ? data[0] : null;
}

async function inspectionRows(driverId: string, tenant: string, vehicle: {id:string;inspection_revision:string}) {
  const {data,error} = await supabase.from('driver_vehicle_inspection_photos').select('id,slot,status,rejection_reason,storage_path')
    .eq('driver_id',driverId).eq('tenant_id',tenant).eq('vehicle_id',vehicle.id)
    .eq('vehicle_revision',vehicle.inspection_revision).neq('status','replaced');
  if (error) throw error;
  return data;
}

router.post('/inspection-requirements-preview', async (req,res) => {
  try {
    const actor = await inspectionActor(req);
    if (!actor || actor.role !== 'driver') return res.sendStatus(403);
    const {category, subtype, services} = req.body || {};
    if (!['bike','standard','xl','small_van','large_van'].includes(category)
        || (category === 'bike' && !['','pedal_bicycle','e_bike','motorcycle','moped'].includes(subtype))
        || !Array.isArray(services) || services.length > 4
        || services.some(service => !['ride','delivery','errand','van'].includes(service))) return res.sendStatus(400);
    const {data:profile,error} = await supabase.from('profiles').select('*').eq('id',actor.id).single();
    if (error) throw error;
    if (!profile.inspection_market_code) return res.status(422).json({error:'Your driver account has no inspection market assigned.'});
    const saved = await inspectionVehicle(actor.id);
    const draftVehicle = {...saved, vehicle_class:category, vehicle_subtype:category === 'bike' ? subtype : null};
    const requirements = getDriverRequirements({
      countryCode:profile.inspection_market_code, driver:profile,
      vehicle:draftVehicle, selectedServices:services
    });
    return res.json({requirements,market:profile.inspection_market_code,slots:inspectionSlots(category==='bike')});
  } catch { return res.status(500).json({error:'Could not preview vehicle requirements.'}); }
});

router.get('/inspection-photos', async (req,res) => {
  try {
    const actor = await inspectionActor(req);
    if (!actor || actor.role !== 'driver' || !actor.tenant_id) return res.sendStatus(403);
    const vehicle = await inspectionVehicle(actor.id);
    if (!vehicle) return res.json({vehicleId:null, slots:[]});
    const rows = await inspectionRows(actor.id,actor.tenant_id,vehicle);
    return res.json({vehicleId:vehicle.id, revision:vehicle.inspection_revision, slots:inspectionSlots(normaliseVehicleClass(vehicle)==='bike').map(slot => {
      const photo = rows.find(row => row.slot === slot);
      return {slot,status:photo?.status || 'missing',reason:photo?.rejection_reason || null};
    })});
  } catch { return res.status(500).json({error:'Could not load inspection photos.'}); }
});

router.put('/inspection-photos/:slot', raw({type:'application/octet-stream',limit:'8mb'}), async (req,res) => {
  try {
    const actor = await inspectionActor(req);
    if (!actor || actor.role !== 'driver' || !actor.tenant_id) return res.sendStatus(403);
    const vehicle = await inspectionVehicle(actor.id);
    if (!vehicle || req.get('x-inspection-vehicle') !== vehicle.inspection_revision) {
      return res.status(409).json({error:'Save or reload your current vehicle before uploading.'});
    }
    const slot = String(req.params.slot);
    if (!inspectionSlots(normaliseVehicleClass(vehicle)==='bike').includes(slot) || !Buffer.isBuffer(req.body)) {
      return res.status(400).json({error:'Choose a valid photo and inspection slot.'});
    }
    let image: Buffer;
    try {
      const source = sharp(req.body,{limitInputPixels:20_000_000});
      const meta = await source.metadata();
      if (!['jpeg','png','webp'].includes(meta.format || '') || !meta.width || !meta.height || Math.min(meta.width,meta.height)<200) {
        return res.status(422).json({error:'Upload a JPEG, PNG or WebP image at least 200 × 200 pixels.'});
      }
      image = await source.rotate().resize({width:2000,height:2000,fit:'inside',withoutEnlargement:true}).jpeg().toBuffer();
    } catch { return res.status(422).json({error:'The selected file is not a readable inspection image.'}); }
    const path = `${actor.tenant_id}/${actor.id}/${randomUUID()}.jpg`;
    const {error: uploadError} = await supabase.storage.from(inspectionBucket).upload(path,image,{contentType:'image/jpeg',upsert:false});
    if (uploadError) throw uploadError;
    const {error} = await supabase.rpc('register_driver_inspection_photo',{
      p_driver:actor.id,p_tenant:actor.tenant_id,p_vehicle:vehicle.id,p_revision:vehicle.inspection_revision,p_slot:slot,p_path:path,p_bytes:image.length,p_ctype:'image/jpeg'
    });
    if (error) {
      await supabase.storage.from(inspectionBucket).remove([path]);
      return res.status(409).json({error:'Could not attach this photo. Reload and try again.'});
    }
    return res.sendStatus(204);
  } catch { return res.status(500).json({error:'Could not upload inspection photo.'}); }
});

router.get('/drivers/:driverId/inspection-photos', async (req,res) => {
  try {
    const actor = await inspectionActor(req);
    if (!actor || actor.role !== 'admin' || !actor.tenant_id) return res.sendStatus(403);
    const driverId = String(req.params.driverId);
    if (!uuidPattern.test(driverId)) return res.sendStatus(404);
    const {data:driver,error} = await supabase.from('profiles').select('tenant_id').eq('id',driverId).maybeSingle();
    if (error) throw error;
    if (!driver || !canReviewInspection(actor,driver)) return res.sendStatus(404);
    const vehicle = await inspectionVehicle(driverId);
    if (!vehicle) return res.json({vehicle:null,slots:[]});
    const rows = await inspectionRows(driverId,actor.tenant_id,vehicle);
    const slots = await Promise.all(inspectionSlots(normaliseVehicleClass(vehicle)==='bike').map(async slot => {
      const photo = rows.find(row => row.slot === slot);
      if (!photo) return {slot,status:'missing'};
      const {data,error:signError} = await supabase.storage.from(inspectionBucket).createSignedUrl(photo.storage_path,120);
      if (signError) throw signError;
      return {id:photo.id,slot,status:photo.status,reason:photo.rejection_reason,url:data.signedUrl};
    }));
    res.set('Cache-Control','no-store');
    return res.json({vehicle:{id:vehicle.id,label:[vehicle.make,vehicle.model,vehicle.license_plate].filter(Boolean).join(' ')},slots});
  } catch { return res.status(500).json({error:'Could not load inspection photos.'}); }
});

router.post('/inspection-photos/:photoId/review', async (req,res) => {
  try {
    const actor = await inspectionActor(req);
    if (!actor || actor.role !== 'admin' || !actor.tenant_id) return res.sendStatus(403);
    const id = String(req.params.photoId);
    if (!uuidPattern.test(id)) return res.sendStatus(404);
    const {status} = req.body || {};
    const reason = typeof req.body?.rejection_reason === 'string' ? req.body.rejection_reason.trim().slice(0,500) : '';
    if (!['approved','rejected'].includes(status) || (status === 'rejected' && !reason)) return res.sendStatus(400);
    const {data:photo,error} = await supabase.from('driver_vehicle_inspection_photos')
      .select('driver_id,vehicle_id,vehicle_revision').eq('id',id).eq('tenant_id',actor.tenant_id).maybeSingle();
    if (error) throw error;
    if (!photo) return res.sendStatus(404);
    const {data:driver,error:driverError} = await supabase.from('profiles').select('tenant_id').eq('id',photo.driver_id).maybeSingle();
    if (driverError) throw driverError;
    if (!driver || !canReviewInspection(actor,driver)) return res.sendStatus(404);
    const vehicle = await inspectionVehicle(photo.driver_id);
    if (vehicle?.id !== photo.vehicle_id || vehicle?.inspection_revision !== photo.vehicle_revision) return res.sendStatus(409);
    const result = await supabase.from('driver_vehicle_inspection_photos').update({
      status,rejection_reason:status==='rejected' ? reason : null,reviewed_by:actor.id,reviewed_at:new Date().toISOString()
    }).eq('id',id).eq('tenant_id',actor.tenant_id).eq('status','under_review').select('id').maybeSingle();
    if (result.error) throw result.error;
    return res.sendStatus(result.data ? 204 : 409);
  } catch { return res.status(500).json({error:'Could not save inspection review.'}); }
});

// The authenticated owner can submit saved details; review state is server owned.
router.post('/driver-submission', async (req, res) => {
  try {
    const token = req.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
    if (!token) return res.status(401).json({ error: 'Sign in to submit your application.' });
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Sign in to submit your application.' });
    const [profileResult, vehicleResult] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', user.id).single(),
      supabase.from('vehicles').select('*').eq('user_id', user.id)
        .order('created_at', { ascending:false }).limit(2)
    ]);
    if (profileResult.error || vehicleResult.error || !profileResult.data) {
      return res.status(500).json({ error: 'Could not read your saved application.' });
    }
    const profile = profileResult.data;
    if (profile.role !== 'driver') return res.status(403).json({ error: 'A driver account is required.' });
    if (profile.is_verified || [profile.driver_review_status, profile.verification_status]
        .some(status => ['approved','under_review'].includes(status))) {
      return res.status(409).json({ error: 'This application is already approved or under review.' });
    }
    if (vehicleResult.data.length !== 1) {
      return res.status(422).json({ error: 'Save exactly one vehicle before submitting.', missing: ['vehicle'] });
    }
    const vehicle = vehicleResult.data[0];
    if (normaliseVehicleClass(vehicle)==='bike' && !['pedal_bicycle','e_bike','motorcycle','moped'].includes(vehicle.vehicle_subtype)) {
      return res.status(422).json({error:'Select and save your bike subtype.',missing:['vehicle_subtype']});
    }
    if (!profile.inspection_market_code) return res.status(422).json({error:'Your driver account has no inspection market assigned.'});
    const blockers = getBlockingRequirements({
      countryCode:profile.inspection_market_code,
      driver:{...profile, email:user.email}, vehicle
    });
    if (blockers.length) return res.status(422).json({
      error:blockers.map(item => item.message).join(' '), missing:blockers.map(item => item.key)
    });
    if (!profile.tenant_id) return res.status(422).json({error:'Your driver account has no inspection tenant assigned.'});
    const slots = inspectionSlots(normaliseVehicleClass(vehicle) === 'bike');
    const photos = await inspectionRows(user.id,profile.tenant_id,vehicle);
    const missing = slots.filter(slot => !photos.some(photo => photo.slot === slot && photo.status === 'approved'));
    if (missing.length) return res.status(422).json({
      error:`Inspection photos still need approval: ${missing.map(slot => slot.replace(/_/g,' ')).join(', ')}.`,
      missing:missing.map(slot => 'inspection.'+slot)
    });
    const {error,data} = await supabase.rpc('submit_driver_with_current_inspection',{
      p_driver:user.id,p_tenant:profile.tenant_id,p_vehicle:vehicle.id,p_revision:vehicle.inspection_revision,p_slots:slots,p_market:profile.inspection_market_code,p_services:vehicle.service_eligibility ?? null
    });
    if (error || !data) return res.status(409).json({error:'Vehicle, inspection or review state changed. Reload before submitting.'});
    return res.json({ status:'under_review' });
  } catch {
    return res.status(500).json({ error: 'Could not submit your application.' });
  }
});

router.use(requireAdmin);

router.post('/drivers/:driverId/dob-correction/:requestId',async(req,res)=>{try{const{driverId,requestId}=req.params;const approved=req.body?.approved===true;const publicMessage=String(req.body?.publicMessage||'').trim();const privateNote=String(req.body?.privateNote||'').trim();const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'').trim();const{data:actor}=await supabase.auth.getUser(token);const now=new Date().toISOString();const{data,error}=await supabase.from('driver_onboarding_requests').update({status:approved?'approved':'rejected',public_message:publicMessage||(approved?'Correction approved. You may update your date of birth once.':'Correction request was not approved.'),private_admin_note:privateNote||null,resolved_at:now,permission_consumed_at:null,updated_at:now}).eq('id',requestId).eq('driver_id',driverId).eq('request_type','identity_correction').select('id,status,public_message').single();if(error||!data)return res.status(404).json({error:error?.message||'DOB correction request not found.'});const{error:auditError}=await supabase.from('driver_requirement_audit').insert({driver_id:driverId,event_type:approved?'dob_correction_granted':'dob_correction_rejected',actor_id:actor.user?.id||null,selected_services:[],requirement_codes:['profile.date_of_birth'],metadata:{requestId,privateNotePresent:!!privateNote}});if(auditError)throw auditError;return res.json({request:data});}catch(error:any){return res.status(500).json({error:error?.message||'Unable to resolve DOB correction request.'});}});

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
      .eq('user_id', driverId)
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
    const authoritativeResolution = DriverRequirementService.resolve({
      profile: driverProfileWithVerificationItems,
      canonicalProfile: mapDriverProfile(profile,!!authUser?.user?.email_confirmed_at),
      vehicle: vehicle ? mapDriverVehicleRow(vehicle) : null,
      authEmailConfirmed: !!authUser?.user?.email_confirmed_at,
      countryCode: profile.country_code || profile.country || vehicle?.country_code
    });
    const blockingRequirements = getBlockingRequirements(requirementsInput);
    // Release closure: the CANONICAL resolution (DriverRequirementService) is the
    // authority for whether a driver can be approved, so admin pre-verify agrees
    // with the mobile setup checklist. The shared engine result is kept only for
    // backward-compatible display fields below.
    const adminReviewRequirements = authoritativeResolution.automaticRequirements.filter((requirement) => requirement.needsAdminReview);
    const blockers = authoritativeResolution.automaticRequirements
      .filter((requirement) => requirement.blockingForSubmission)
      .map((requirement) => requirement.reason);
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
      authoritativeResolution,
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

// Informational messages never change verification or outstanding requirements.
router.post('/drivers/:driverId/message', async (req, res) => {
  try {
    const body = String(req.body?.message || '').trim();
    if (!body || body.length > 2000) return res.status(422).json({ error: 'Enter a message of 1–2000 characters.' });
    const { driverId } = req.params;
    const { data: driver, error: profileError } = await supabase.from('profiles').select('id,role').eq('id', driverId).single();
    if (profileError || !driver || driver.role !== 'driver') return res.status(404).json({ error: 'Driver not found.' });
    const { data, error } = await supabase.from('notifications').insert({
      user_id: driverId, title: 'Message from Vaydu Admin', body, type: 'system_alert',
      data: { action: 'admin_driver_message', admin_sender_id:(req as any).adminUserId, route: '/driver/settings' },
      metadata: { action: 'admin_driver_message', admin_sender_id:(req as any).adminUserId, route: '/driver/settings' },
      route: '/driver/settings', is_read: false
    }).select('id').single();
    if (error || !data) throw error || new Error('Message was not saved.');
    await NotificationService.pushSavedAdminMessage(driverId, data.id, 'driver').catch(error => console.warn('[AdminDriverMessage] push failed:', error?.message));
    return res.status(201).json({ sent: true, messageId: data.id });
  } catch (error: unknown) {
    console.error('[AdminDriverMessage] save failed', error);
    return res.status(500).json({ error: 'Could not save the driver message.' });
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

    // See DriverOnboardingNotificationService.enqueue: `profiles.first_name` does not exist
    // in this schema, so a hand-written column list here would 42703 the same way. The
    // name fallback below tolerates the columns being absent.
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
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

    // Reconcile with the mobile "Outstanding Requests" feed, which reads
    // driver_onboarding_requests (not the blocker columns). One open
    // 'admin.missing_info' row per driver keeps the partial unique index
    // idx_driver_onboarding_requests_one_open satisfied and makes the explicit
    // admin request visible to the driver.
    const requestItem = selectedBlockers.length
      ? selectedBlockers.join(' · ').slice(0, 160)
      : 'Update your details';
    const requestMessage = String(notes || '').trim() || requestItem;
    // Deterministic single-row lookup. `.maybeSingle()` ERRORS when more than one
    // row matches, which previously left `data` null and fell through to an INSERT
    // -- tripping idx_driver_onboarding_requests_one_open and failing the Admin
    // request with a 500. Take the newest open row explicitly instead.
    const { data: existingOpenRequests, error: existingOpenError } = await supabase
      .from('driver_onboarding_requests')
      .select('id')
      .eq('driver_id', driverId)
      .eq('requirement_code', 'admin.missing_info')
      .in('status', ['pending', 'rejected'])
      .order('created_at', { ascending: false })
      .limit(1);
    if (existingOpenError) throw existingOpenError;
    const existingOpenRequest = existingOpenRequests?.[0] ?? null;
    const requestPatch = {
      item: requestItem,
      public_message: requestMessage,
      request_type: 'missing_info',
      status: 'pending',
      sent_at: sentAt,
      updated_at: sentAt
    };
    if (existingOpenRequest) {
      const { error: requestUpdateError } = await supabase
        .from('driver_onboarding_requests')
        .update(requestPatch)
        .eq('id', existingOpenRequest.id);
      if (requestUpdateError) throw requestUpdateError;
    } else {
      const { error: requestInsertError } = await supabase
        .from('driver_onboarding_requests')
        .insert({ driver_id: driverId, requirement_code: 'admin.missing_info', ...requestPatch });
      if (requestInsertError) throw requestInsertError;
    }

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
    const actor = await inspectionActor(req);
    const {data:driver,error:driverError} = await supabase.from('profiles').select('tenant_id').eq('id',driverId).maybeSingle();
    if (driverError) throw driverError;
    if (!actor || !driver || !canReviewInspection(actor,driver)) return res.sendStatus(404);

    const { notes, testingOverride } = req.body || {};

    if (!testingOverride) {
      return res.status(400).json({
        error: 'Manual approval requires testingOverride=true'
      });
    }

    // Approval must never contradict the canonical requirement engine: evaluate the
    // exact same requirements the driver sees before granting approval.
    const { data: approvalProfile, error: approvalProfileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', driverId)
      .single();

    if (approvalProfileError || !approvalProfile) {
      return res.status(404).json({ error: approvalProfileError?.message || 'Driver profile not found.' });
    }

    const { data: approvalVehicleRow } = await supabase
      .from('vehicles')
      .select('*')
      .eq('user_id', driverId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: approvalAuth } = await supabase.auth.admin.getUserById(driverId);
    const approvalCanonicalProfile = mapDriverProfile(approvalProfile, !!approvalAuth?.user?.email_confirmed_at);
    const approvalResolution = DriverRequirementService.resolve({
      profile: approvalProfile,
      canonicalProfile: approvalCanonicalProfile,
      vehicle: approvalVehicleRow ? mapDriverVehicleRow(approvalVehicleRow) : null,
      authEmailConfirmed: approvalCanonicalProfile.emailConfirmed,
      countryCode: approvalProfile.country_code,
      marketCity: approvalProfile.market_city || approvalProfile.city
    });

    const approvalBlockers = approvalResolution.automaticRequirements.filter((item) => item.blockingForSubmission);

    if (approvalBlockers.length) {
      return res.status(422).json({
        error: approvalBlockers[0].reason,
        code: 'DRIVER_REQUIREMENTS_INCOMPLETE',
        requirements: approvalBlockers,
        progress: approvalResolution.progress
      });
    }

    const { error, data } = await supabase
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
      .eq('id', driverId).eq('tenant_id',actor.tenant_id).eq('driver_review_status','under_review')
      .select('id').maybeSingle();

    if (error) throw error;
    if (!data) return res.status(409).json({error:'The driver must submit a current inspection before approval.'});

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

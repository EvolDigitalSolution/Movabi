/**
 * Vehicle-inspection evidence for the driver's CURRENT vehicle and inspection revision, as the readiness
 * response, submission, admin approval and driver eligibility all need it (2026-11-13).
 *
 * Required slots come from the existing policy (server/shared/driver-inspection.ts): six for motor
 * vehicles (front, rear, dashboard, seats_interior, left_side, right_side) and three for bikes (front,
 * rear, side), which preserves the bicycle exemption. A slot counts as UPLOADED only with a saved photo
 * for the current vehicle + revision + tenant whose status is uploaded, under_review or approved.
 * Replaced (removed) photos never count, and a rejected or replacement_required photo must be replaced.
 * Upload completion and admin approval are reported separately.
 */
import {inspectionSlots} from '../shared/driver-inspection';
import {normaliseVehicleClass} from '../shared/driver-requirements.engine';

export type {InspectionEvidence, InspectionProgress, InspectionSlotState} from './driver-inspection-progress';
export {inspectionProgress} from './driver-inspection-progress';
import {inspectionProgress} from './driver-inspection-progress';
import type {InspectionEvidence} from './driver-inspection-progress';

/** Load the evidence for one driver (service-role client). No vehicle: nothing can be uploaded yet. */
export async function loadInspectionEvidence(db: any, driverId: string, tenantId: string | null | undefined,
  vehicleRow: {id?: string | null; inspection_revision?: string | null} | null | undefined): Promise<InspectionEvidence> {
  if (!vehicleRow?.id) return {vehicle: false, bike: false, requiredSlots: [...inspectionSlots(false)], photos: []};
  const bike = normaliseVehicleClass(vehicleRow as any) === 'bike';
  const requiredSlots = [...inspectionSlots(bike)];
  if (!tenantId || !vehicleRow.inspection_revision) return {vehicle: true, bike, requiredSlots, photos: []};
  const {data, error} = await db.from('driver_vehicle_inspection_photos').select('slot,status')
    .eq('driver_id', driverId).eq('tenant_id', tenantId).eq('vehicle_id', vehicleRow.id)
    .eq('vehicle_revision', vehicleRow.inspection_revision).neq('status', 'replaced');
  if (error) throw error;
  return {vehicle: true, bike, requiredSlots, photos: (data || []).map((p: any) => ({slot: String(p.slot), status: String(p.status)}))};
}

/**
 * Acquisition gate: throws (code INSPECTION_NOT_APPROVED) unless every required photo of the driver's
 * single current vehicle is approved for its current inspection revision.
 */
export async function assertInspectionApproved(db: any, driverId: string): Promise<void> {
  const [{data: profile, error: profileError}, {data: vehicles, error: vehicleError}] = await Promise.all([
    db.from('profiles').select('tenant_id').eq('id', driverId).maybeSingle(),
    db.from('vehicles').select('*').eq('user_id', driverId).order('created_at', {ascending: false}).limit(2),
  ]);
  if (profileError || vehicleError) throw Object.assign(new Error('Vehicle inspection status is unavailable. Please retry.'), {code: 'INSPECTION_STATUS_UNAVAILABLE'});
  const vehicle = (vehicles || []).length === 1 ? vehicles[0] : null;
  const progress = inspectionProgress(await loadInspectionEvidence(db, driverId, profile?.tenant_id, vehicle));
  if (!progress.approvalComplete) throw Object.assign(new Error(progress.uploadsComplete
    ? 'Your vehicle inspection is awaiting admin review.'
    : 'Upload and get approval for all required vehicle inspection photos before accepting work.'), {code: 'INSPECTION_NOT_APPROVED'});
}

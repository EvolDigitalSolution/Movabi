export const BIKE_PHOTO_SLOTS = ['front', 'rear', 'side'] as const;
export const MOTOR_PHOTO_SLOTS = ['front', 'rear', 'dashboard', 'seats_interior', 'left_side', 'right_side'] as const;

export function inspectionSlots(bike: boolean): readonly string[] {
  return bike ? BIKE_PHOTO_SLOTS : MOTOR_PHOTO_SLOTS;
}

export function canReviewInspection(reviewer: {role?: string; tenant_id?: string | null}, driver: {tenant_id?: string | null}): boolean {
  return reviewer.role === 'admin' && !!reviewer.tenant_id && reviewer.tenant_id === driver.tenant_id;
}

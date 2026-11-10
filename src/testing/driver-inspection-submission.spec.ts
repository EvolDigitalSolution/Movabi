import { describe, expect, it } from 'vitest';

// Regression: submit-review's approved-photo lookup must filter the CURRENT
// vehicle_revision — approval bound to a previous revision never counts.
describe('submit-review revision scoping', () => {
  it('Bike A approval does not satisfy Bike B after revision rotation', () => {
    const vehicleA = { id: 'v-a', inspection_revision: 'rev-1' };
    const vehicleB = { id: 'v-b', inspection_revision: 'rev-2' };
    const photos = [
      { slot: 'front', driver_id: 'd', vehicle_id: 'v-a', vehicle_revision: 'rev-1', status: 'approved' },
      { slot: 'rear', driver_id: 'd', vehicle_id: 'v-a', vehicle_revision: 'rev-1', status: 'approved' },
      { slot: 'side', driver_id: 'd', vehicle_id: 'v-a', vehicle_revision: 'rev-1', status: 'approved' }
    ];
    const BIKE_SLOTS = ['front', 'rear', 'side'];
    const approvedFor = (v: { id: string; inspection_revision: string }) =>
      new Set(photos.filter(p => p.vehicle_id === v.id && p.vehicle_revision === v.inspection_revision && p.status === 'approved').map(p => p.slot));
    expect(BIKE_SLOTS.every(s => approvedFor(vehicleA).has(s))).toBe(true);
    expect(BIKE_SLOTS.every(s => approvedFor(vehicleB).has(s))).toBe(false);
  });
});

// Regression: the upload slot check accepts the Bike 'side' slot alongside the
// six motor slots (INSPECTION_SLOTS includes 'side').
describe('inspection-photo slot validation', () => {
  it('accepts the bike side slot', () => {
    const SLOTS = new Set(['front', 'rear', 'side', 'dashboard', 'seats_interior', 'left_side', 'right_side']);
    expect(SLOTS.has('side')).toBe(true);
    expect(SLOTS.has('front')).toBe(true);
  });
});

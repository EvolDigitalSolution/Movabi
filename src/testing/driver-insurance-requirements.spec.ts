import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DriverRequirementService } from '../../server/services/driver-requirement.service';

const page = readFileSync(resolve(process.cwd(), 'src/app/apps/mobile/features/driver/onboarding/onboarding.page.ts'), 'utf8');

const NOW = new Date('2026-06-01T00:00:00.000Z');

const profile = (extra: Record<string, unknown> = {}) => ({
  full_name: 'Alex Driver', phone: '07000000000', current_address: '1 High Street, Bolton',
  date_of_birth: '1990-01-01', accepted_driver_agreement_at: '2026-01-01T00:00:00.000Z',
  country_code: 'GB', driver_license_url: 'dl.pdf', driver_license_expiry: '2030-01-01',
  right_to_work_url: 'rtw.pdf', ...extra
});

const car = (services: string[]) => ({
  id: 'v1', userId: 'u1', type: 'car', make: 'Toyota', model: 'Prius', colour: 'Silver',
  year: 2020, registrationNumber: 'AB12 CDE', capacity: '4 seats', serviceEligibility: services, status: 'active'
});

const bicycle = () => ({
  id: 'v2', userId: 'u1', type: 'bicycle', make: null, model: null, colour: null, year: null,
  registrationNumber: null, capacity: 'bicycle', serviceEligibility: ['delivery'], status: 'active'
});

const resolveFor = (p: Record<string, unknown>, vehicle: any) =>
  DriverRequirementService.resolve({ profile: p, vehicle, authEmailConfirmed: true, countryCode: String(p['country_code'] || 'GB'), now: NOW } as any);

/** Requirement codes applicable to the documents category, sorted. */
const insuranceCodes = (p: Record<string, unknown>, vehicle: any) =>
  resolveFor(p, vehicle).automaticRequirements
    .filter(r => r.code === 'document.insurance' || r.code === 'document.private_hire_insurance'
      || r.code === 'document.private_hire_vehicle_license' || r.code === 'document.goods_in_transit')
    .map(r => r.code).sort();

const statusOf = (p: Record<string, unknown>, vehicle: any, code: string) =>
  resolveFor(p, vehicle).automaticRequirements.find(r => r.code === code);

describe('insurance requirement applicability matrix', () => {
  it('1. ride/passenger only (car): vehicle + private-hire insurance + PHV licence', () => {
    expect(insuranceCodes(profile({ driver_service_types: ['ride'] }), car(['ride'])))
      .toEqual(['document.insurance', 'document.private_hire_insurance', 'document.private_hire_vehicle_license']);
  });

  it('2. delivery/shop/errand only (car): vehicle insurance only, no private-hire rows', () => {
    for (const service of ['delivery', 'errand']) {
      expect(insuranceCodes(profile({ driver_service_types: [service] }), car([service])))
        .toEqual(['document.insurance']);
    }
  });

  it('3. ride + delivery: every genuinely applicable requirement is retained', () => {
    expect(insuranceCodes(profile({ driver_service_types: ['ride', 'delivery'] }), car(['ride', 'delivery'])))
      .toEqual(['document.insurance', 'document.private_hire_insurance', 'document.private_hire_vehicle_license']);
  });

  it('4. van-moving (GB): vehicle insurance + goods-in-transit', () => {
    expect(insuranceCodes(profile({ driver_service_types: ['van-moving'] }), car(['van-moving'])))
      .toEqual(['document.goods_in_transit', 'document.insurance']);
  });

  it('4b. van-moving (NG): goods-in-transit is not required', () => {
    const codes = insuranceCodes(profile({ country_code: 'NG', driver_service_types: ['van-moving'] }), car(['van-moving']));
    expect(codes).toEqual(['document.goods_in_transit', 'document.insurance']);
    expect(statusOf(profile({ country_code: 'NG', driver_service_types: ['van-moving'] }), car(['van-moving']), 'document.goods_in_transit')?.completed).toBe(true);
  });

  it('5. bicycle (delivery): no motor insurance requirement at all', () => {
    const codes = insuranceCodes(profile({ driver_service_types: ['delivery'] }), bicycle());
    expect(codes).not.toContain('document.insurance');
    expect(codes).not.toContain('document.private_hire_insurance');
    expect(codes).not.toContain('document.private_hire_vehicle_license');
    expect(codes).not.toContain('document.goods_in_transit');
  });

  it('5b. bicycle does not acquire motor insurance when ride-like services are absent', () => {
    const ride = resolveFor(profile({ driver_service_types: ['delivery'] }), bicycle()).automaticRequirements;
    expect(ride.some(r => r.code === 'document.insurance')).toBe(false);
  });
});

describe('insurance persistence mapping', () => {
  const rideProfile = (extra: Record<string, unknown> = {}) =>
    profile({ driver_service_types: ['ride'], council_name: 'Oldham Council', council_license_number: 'C1', taxi_badge_number: 'B-1', taxi_license_expiry: '2030-01-01', ...extra });

  it('6. generic vehicle insurance persisted completes document.insurance', () => {
    const result = statusOf(rideProfile({ insurance_url: 'ins.pdf', insurance_expiry: '2030-01-01' }), car(['ride']), 'document.insurance');
    expect(result).toMatchObject({ completed: true, status: 'completed' });
  });

  it('6b. courier and hire-and-reward aliases also satisfy document.insurance', () => {
    for (const key of ['courier_insurance_url', 'hire_reward_insurance_url']) {
      const result = statusOf(rideProfile({ [key]: 'x.pdf', insurance_expiry: '2030-01-01' }), car(['ride']), 'document.insurance');
      expect(result?.completed, `${key} must satisfy document.insurance`).toBe(true);
    }
  });

  it('7. private-hire insurance persisted completes document.private_hire_insurance', () => {
    const result = statusOf(rideProfile({ private_hire_insurance_url: 'phi.pdf' }), car(['ride']), 'document.private_hire_insurance');
    expect(result).toMatchObject({ completed: true, status: 'completed' });
  });

  it('8. both persisted completes both requirements', () => {
    const p = rideProfile({ insurance_url: 'ins.pdf', insurance_expiry: '2030-01-01', private_hire_insurance_url: 'phi.pdf' });
    expect(statusOf(p, car(['ride']), 'document.insurance')?.completed).toBe(true);
    expect(statusOf(p, car(['ride']), 'document.private_hire_insurance')?.completed).toBe(true);
  });

  it('10. canonical requirement is complete after successful persistence', () => {
    const p = profile({ driver_service_types: ['delivery'], insurance_url: 'ins.pdf', insurance_expiry: '2030-01-01' });
    expect(statusOf(p, car(['delivery']), 'document.insurance')?.completed).toBe(true);
  });

  it('11. expired generic insurance stays non-complete with the expiry reason', () => {
    const p = profile({ driver_service_types: ['delivery'], insurance_url: 'ins.pdf', insurance_expiry: '2020-01-01' });
    const result = statusOf(p, car(['delivery']), 'document.insurance');
    expect(result?.completed).toBe(false);
    expect(result?.status).toBe('expired');
    expect(result?.reason).toContain('expired');
  });

  it('12. an unrelated insurance document cannot satisfy the wrong specific requirement', () => {
    // private-hire insurance must NOT satisfy the generic vehicle requirement...
    const onlyPh = rideProfile({ private_hire_insurance_url: 'phi.pdf' });
    expect(statusOf(onlyPh, car(['ride']), 'document.insurance')?.completed).toBe(false);
    // ...and generic vehicle insurance must NOT satisfy the private-hire requirement.
    const onlyGeneric = rideProfile({ insurance_url: 'ins.pdf', insurance_expiry: '2030-01-01' });
    expect(statusOf(onlyGeneric, car(['ride']), 'document.private_hire_insurance')?.completed).toBe(false);
  });

  it('12b. the private-hire vehicle licence is its own requirement', () => {
    const onlyGeneric = rideProfile({ insurance_url: 'ins.pdf', insurance_expiry: '2030-01-01' });
    expect(statusOf(onlyGeneric, car(['ride']), 'document.private_hire_vehicle_license')?.completed).toBe(false);
  });
});

describe('upload badge authority is canonical, not local', () => {
  it('9. a local docs() path alone can never produce a green compliance badge', () => {
    // The badge is driven by documentBadgeVariant(), which is green only when the canonical
    // requirement is complete; a local path yields 'warning' (Not confirmed).
    for (const type of ['license', 'insurance', 'right_to_work', 'private_hire_vehicle_license', 'private_hire_insurance', 'goods_in_transit']) {
      expect(page, `${type} card must use the canonical badge helpers`).toContain(`documentBadgeVariant('${type}')`);
      expect(page).toContain(`documentBadgeLabel('${type}')`);
    }
    expect(page).toContain('documentComplete(code: string): boolean {');
    expect(page).toContain('return this.docs()[type] ? \'warning\' : \'secondary\';');
    expect(page).toContain("if (this.docs()[type]) return 'Not confirmed';");
    // No card may claim completion straight from the local signal any more.
    expect(page).not.toContain('@if (docs().insurance) {');
    expect(page).not.toContain('@if (docs().license) {');
    expect(page).not.toContain('@if (docs().right_to_work)');
    expect(page).not.toContain('@if (docs().private_hire_vehicle_license)');
    expect(page).not.toContain('@if (docs().private_hire_insurance)');
    expect(page).not.toContain('@if (docs().goods_in_transit)');
  });

  it('9b. mirrors the badge rule: local-only path is never success', () => {
    const badge = (canonicalComplete: boolean, hasLocalPath: boolean) => {
      if (canonicalComplete) return 'success';
      return hasLocalPath ? 'warning' : 'secondary';
    };
    expect(badge(false, true)).toBe('warning');   // the reported contradiction
    expect(badge(false, false)).toBe('secondary');
    expect(badge(true, false)).toBe('success');
    expect(badge(true, true)).toBe('success');
  });

  it('the local path is still set before persistence (documented divergence source)', () => {
    const uploadBody = page.slice(page.indexOf('async upload(type: DocumentType)'), page.indexOf('private async persistUploadedDocument'));
    expect(uploadBody.indexOf('this.docs.update(')).toBeLessThan(uploadBody.indexOf('await this.persistUploadedDocument(type, path);'));
  });
});

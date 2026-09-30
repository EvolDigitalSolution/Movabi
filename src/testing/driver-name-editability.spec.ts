import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DriverIdentityEditabilityService } from '../../server/services/driver-identity-editability.service';
import { DriverRequirementService } from '../../server/services/driver-requirement.service';

const route = readFileSync(resolve(process.cwd(), 'server/routes/driver-onboarding.routes.ts'), 'utf8');
const account = readFileSync(resolve(process.cwd(), 'src/app/apps/mobile/features/account/account-settings.page.ts'), 'utf8');

describe('driver legal-name identity editability', () => {
    it('allows an unverified/onboarding driver to edit their legal name', () => {
        expect(DriverIdentityEditabilityService.resolve({ onboarding_completed: false, verification_status: 'incomplete' }).fullNameEditable).toBe(true);
    });

    it('locks a verified driver (is_verified)', () => {
        expect(DriverIdentityEditabilityService.resolve({ is_verified: true, verification_status: 'approved' }).fullNameEditable).toBe(false);
    });

    it('locks a verified driver (verification_status approved)', () => {
        expect(DriverIdentityEditabilityService.resolve({ verification_status: 'approved' }).fullNameEditable).toBe(false);
    });

    it('locks a historically-verified driver even while action-required', () => {
        expect(DriverIdentityEditabilityService.resolve({ is_verified: true, verification_status: 'action_required' }).fullNameEditable).toBe(false);
    });

    it('rejects a verified-driver name change with the stable code', () => {
        expect(route).toContain("res.status(403).json({code:'NAME_CHANGE_NOT_ALLOWED'");
        expect(route).toContain('editability.fullNameEditable');
    });

    it('renders the name read-only for verified drivers', () => {
        expect(account).toContain('isVerifiedDriver()');
        expect(account).toContain('[readonly]="isVerifiedDriver()"');
        expect(account).toContain('tied to your verified driver identity');
    });

    it('routes driver name changes through the server-authoritative endpoint', () => {
        expect(account).toContain('nameChanged ? { fullName } : {}');
        expect(account).toContain('this.onboardingStatus.saveCurrentProfile');
    });
});

describe('driver country-code identity editability', () => {
    it('allows an unverified driver to change country', () => {
        expect(DriverIdentityEditabilityService.resolve({ onboarding_completed: false, verification_status: 'incomplete' }).countryCodeEditable).toBe(true);
    });

    it('locks a verified driver from changing country', () => {
        expect(DriverIdentityEditabilityService.resolve({ is_verified: true, verification_status: 'approved' }).countryCodeEditable).toBe(false);
        expect(DriverIdentityEditabilityService.resolve({ verification_status: 'approved' }).countryCodeEditable).toBe(false);
    });

    it('rejects a verified-driver country change with the stable code', () => {
        expect(route).toContain("res.status(403).json({code:'COUNTRY_CHANGE_NOT_ALLOWED'");
        expect(route).toContain('editability.countryCodeEditable');
    });

    it('renders the country read-only for verified drivers', () => {
        expect(account).toContain('Your operating country is tied to your verified driver identity');
    });

    it('routes driver country changes through the server-authoritative endpoint', () => {
        expect(account).toContain('countryChanged ? { countryCode } : {}');
    });
});

describe('country_code materially alters compliance applicability', () => {
    const base = {
        id: 'd1', full_name: 'A', phone: '1', current_address: 'A', date_of_birth: '1990-01-01',
        accepted_driver_agreement_at: '2026-01-01', driver_license_url: 'dl.pdf', driver_license_expiry: '2030-01-01',
        insurance_url: 'ins.pdf', insurance_expiry: '2030-01-01', driver_service_types: ['delivery'],
        is_verified: true, verification_status: 'approved'
    };
    const resolveWith = (country: string) => DriverRequirementService.resolve({
        profile: { ...base, country_code: country, right_to_work_url: null, right_to_work_share_code: null },
        vehicle: null, authEmailConfirmed: true, now: new Date('2026-08-04')
    });

    it('GB requires right to work; non-GB does not', () => {
        expect(resolveWith('GB').automaticRequirements.find(r => r.code === 'work.right_to_work')?.status).toBe('missing');
        expect(resolveWith('IE').automaticRequirements.find(r => r.code === 'work.right_to_work')).toBeUndefined();
    });
});

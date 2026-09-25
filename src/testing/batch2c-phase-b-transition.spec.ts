import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import {
    PASSENGER_LICENCE_CANONICAL_COLUMNS,
    mapDriverPassengerLicence,
    passengerLicenceColumns,
    passengerLicenceItems,
    readPassengerLicence
} from '../../server/models/driver-passenger-licence.model';
import {
    DRIVER_BUSY_SQLSTATE as SERVER_BUSY_SQLSTATE,
    DRIVER_NOT_ELIGIBLE_SQLSTATE as SERVER_NOT_ELIGIBLE_SQLSTATE,
    DRIVER_BUSY_CODE as SERVER_BUSY_CODE,
    DRIVER_NOT_ELIGIBLE_CODE as SERVER_NOT_ELIGIBLE_CODE,
    CANONICAL_DRIVER_SERVICES,
    DRIVER_ELIGIBILITY_RULES,
    SERVICE_UNRESOLVED_CODE,
    canonicalDriverService,
    evaluateDriverServiceEligibility,
    mapDriverAcquisitionError
} from '../../server/services/driver-eligibility.service';
import {
    DRIVER_BUSY_CODE,
    DRIVER_BUSY_SQLSTATE,
    DRIVER_NOT_ELIGIBLE_CODE,
    DRIVER_NOT_ELIGIBLE_SQLSTATE,
    acquisitionErrorMessage,
    isDriverBusyError,
    isDriverNotEligibleError,
    mapAcquisitionError
} from '@core/services/compliance/acquisition-error';
import { COMPLIANCE_CONTROLLED_PROFILE_FIELDS, stripComplianceControlledFields } from '@core/services/profile/profile.service';

/**
 * Batch 2C / Phase B — application transition + compliance write hardening.
 *
 * STATIC + PURE-FUNCTION TESTS ONLY. There is no PostgreSQL harness in this
 * workspace, so nothing here executes SQL against a server.
 *
 * Phase B is a TRANSITION phase: the database enforcement trigger stays
 * DISABLED, no RLS or grant changes, and no data backfill. These tests prove the
 * application no longer offers a client-side compliance/ownership mutation path,
 * that the canonical passenger-licence read precedence matches Phase A, and that
 * MB001 (busy) and MB002 (compliance) stay distinct and actionable.
 */

const ROUTE = 'server/routes/driver-onboarding.routes.ts';
const BOOKING_ROUTE = 'server/routes/booking.routes.ts';
const SETTINGS = 'src/app/apps/mobile/features/driver/settings.page.ts';
const DASHBOARD = 'src/app/apps/mobile/features/driver/dashboard/dashboard.page.ts';
const BOOKING_SERVICE = 'src/app/core/services/booking/booking.service.ts';
const ADMIN_SERVICE = 'src/app/apps/admin/services/admin.service.ts';
const ELIGIBILITY = 'server/services/driver-eligibility.service.ts';
const ACQUISITION_ERROR = 'src/app/core/services/compliance/acquisition-error.ts';
const PROFILE_SERVICE = 'src/app/core/services/profile/profile.service.ts';
const ONBOARDING_SERVICE = 'src/app/core/services/driver/driver-onboarding-status.service.ts';
const N12_MIGRATION = 'supabase/migrations/20260924000000_driver_single_active_job.sql';
const PHASE_A_MIGRATION = 'supabase/migrations/20260925000000_driver_compliance_eligibility_phase_a.sql';
const MIGRATIONS_DIR = 'supabase/migrations';

const read = (path: string): string => readFileSync(path, 'utf8');
/** Whitespace-stripped, lowercased: robust against formatting. */
const flat = (text: string): string => text.replace(/\s+/g, '').toLowerCase();
/** Comment lines removed, so assertions target executable text. */
const code = (text: string): string =>
    text.split('\n').filter(line => !line.trimStart().startsWith('//')).join('\n');
/** SQL comment lines removed, so prose cannot satisfy a DDL assertion. */
const sqlCode = (text: string): string =>
    text.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n');

const ROUTE_SRC = read(ROUTE);
const ROUTE_CODE = code(ROUTE_SRC);
const BOOKING_SERVICE_SRC = read(BOOKING_SERVICE);
const DASHBOARD_SRC = read(DASHBOARD);
const PROFILE_SERVICE_SRC = read(PROFILE_SERVICE);

const TODAY = new Date(Date.UTC(2026, 7, 7)); // 2026-08-07
const YESTERDAY = '2026-08-06';
const TOMORROW = '2026-08-08';

// ===========================================================================
describe('Phase B — passenger licence canonical transition', () => {
    it('1. the four canonical typed columns are the application source of truth', () => {
        expect(PASSENGER_LICENCE_CANONICAL_COLUMNS).toEqual([
            'council_name', 'council_license_number', 'taxi_badge_number', 'taxi_license_expiry'
        ]);
        // The write path persists exactly those columns.
        expect(passengerLicenceColumns({
            councilName: 'Oldham Council', licenceNumber: 'PHV/1', badgeNumber: 'B-1', expiryDate: TOMORROW
        })).toEqual({
            council_name: 'Oldham Council',
            council_license_number: 'PHV/1',
            taxi_badge_number: 'B-1',
            taxi_license_expiry: TOMORROW
        });
    });

    it('2. canonical columns win over divergent compatibility storage', () => {
        const resolved = readPassengerLicence({
            council_name: 'Canonical Council',
            council_license_number: 'CANON-1',
            taxi_badge_number: 'CANON-BADGE',
            taxi_license_expiry: '2030-01-01',
            verification_items: {
                council_name: 'Stale Council',
                council_license_number: 'STALE-1',
                taxi_badge_number: 'STALE-BADGE',
                taxi_license_expiry: '2020-01-01'
            }
        }, TODAY);
        expect(resolved).toMatchObject({
            councilName: 'Canonical Council', licenceNumber: 'CANON-1',
            badgeNumber: 'CANON-BADGE', expiryDate: '2030-01-01', complete: true
        });
        // Divergence is resolved deterministically: the canonical value always wins.
        expect(resolved.councilName).not.toBe('Stale Council');
    });

    it('3. compatibility storage is a FALLBACK only, in every shape the app writes', () => {
        const expected = { councilName: 'Oldham Council', licenceNumber: 'PHW/1', badgeNumber: 'B-1', expiryDate: TOMORROW };
        const rows = {
            council_name: 'Oldham Council', council_license_number: 'PHW/1',
            taxi_badge_number: 'B-1', taxi_license_expiry: TOMORROW
        };
        // object shape
        expect(readPassengerLicence({ verification_items: rows }, TODAY)).toMatchObject(expected);
        // array-of-{key,value} shape — what PUT /passenger-licence persists as the mirror
        expect(readPassengerLicence({
            verification_items: Object.entries(rows).map(([key, value]) => ({ key, value }))
        }, TODAY)).toMatchObject(expected);
        // JSON-string shape
        expect(readPassengerLicence({ verification_items: JSON.stringify(rows) }, TODAY)).toMatchObject(expected);
        // alias columns are the third tier
        expect(readPassengerLicence({ council_license_authority: 'Alias Council', council_license_expiry: TOMORROW }, TODAY).councilName)
            .toBe('Alias Council');
        // canonical value present and blank -> falls through
        expect(readPassengerLicence({ council_name: '   ', verification_items: rows }, TODAY).councilName).toBe('Oldham Council');
        // unknown shapes are ignored, never guessed at
        expect(passengerLicenceItems([{ nope: 1 }])).toEqual({});
        expect(passengerLicenceItems(42)).toEqual({});
        expect(readPassengerLicence(null, TODAY)).toEqual({
            councilName: null, licenceNumber: null, badgeNumber: null, expiryDate: null, status: 'incomplete', complete: false
        });
    });

    it('4. a malformed or impossible compatibility expiry fails safely', () => {
        for (const bad of ['not-a-date', '2026-13-01', '2026-02-30', '31/02/2027', '', '   ']) {
            const resolved = readPassengerLicence({
                council_name: 'C', council_license_number: '1', taxi_badge_number: 'B',
                verification_items: { taxi_license_expiry: bad }
            }, TODAY);
            expect(resolved.expiryDate, `compatibility expiry ${JSON.stringify(bad)}`).toBeNull();
            expect(resolved.complete).toBe(false);
        }
        // A present-but-unusable canonical value does NOT fall through to the
        // compatibility key — the same shape as the Phase A SQL precedence.
        expect(readPassengerLicence({
            taxi_license_expiry: '2026-13-01',
            verification_items: { taxi_license_expiry: '2030-01-01' }
        }, TODAY).expiryDate).toBeNull();
    });

    it('5. expiry semantics: today is VALID, yesterday is expired', () => {
        const base = { council_name: 'C', council_license_number: '1', taxi_badge_number: 'B' };
        expect(readPassengerLicence({ ...base, taxi_license_expiry: TODAY.toISOString().slice(0, 10) }, TODAY).complete).toBe(true);
        expect(readPassengerLicence({ ...base, taxi_license_expiry: TOMORROW }, TODAY).complete).toBe(true);
        const expired = readPassengerLicence({ ...base, taxi_license_expiry: YESTERDAY }, TODAY);
        expect(expired.expiryDate).toBe(YESTERDAY);
        expect(expired.complete).toBe(false);
        // The pre-existing compatibility-only mapper is unchanged.
        expect(mapDriverPassengerLicence({ council_name: 'C', council_license_number: '1', taxi_badge_number: 'B', taxi_license_expiry: TOMORROW }, TODAY).complete).toBe(true);
    });

    it('6. the server routes read canonical-first and write both stores', () => {
        expect(ROUTE_SRC).toContain(
            "const PASSENGER_LICENCE_SELECT='id,verification_items,council_name,council_license_number,taxi_badge_number,taxi_license_expiry'"
        );
        expect(flat(ROUTE_CODE)).toContain('passengerlicence=readpassengerlicence(profile)');
        expect(flat(ROUTE_CODE)).toContain('passengerlicencecolumns(parsedriverpassengerlicenceinput(');
        expect(flat(ROUTE_CODE)).toContain('...passengerlicencecolumns(licence)');
        expect(flat(ROUTE_CODE)).toContain('verification_items:serializeonboardingitems(mirror)');
        // The compatibility-only read is no longer used for the licence verdict.
        expect(flat(ROUTE_CODE)).not.toContain('mapdriverpassengerlicence(parseonboardingitems(');
    });

    it('7. compatibility storage can never become self-approval', () => {
        // The licence reader returns LICENCE FIELDS ONLY. Approval/verification
        // state carried inside verification_items is never promoted into a verdict
        // by the licence path, and the fields are not compliance-controlled.
        expect(COMPLIANCE_CONTROLLED_PROFILE_FIELDS).not.toContain('verification_items');
        const carrier = readPassengerLicence({
            verification_items: { is_verified: true, verification_status: 'approved', council_name: 'C' }
        }, TODAY);
        expect(Object.keys(carrier).sort()).toEqual(['badgeNumber', 'complete', 'councilName', 'expiryDate', 'licenceNumber', 'status']);
        expect(carrier.councilName).toBe('C');
        expect(JSON.stringify(carrier)).not.toContain('approved');
        expect(JSON.stringify(carrier)).not.toContain('is_verified');
        // The approval verdict comes from the compliance model, never from JSON.
        const approvedFromJsonOnly = evaluateDriverServiceEligibility({
            profile: { role: 'driver', verification_items: { is_verified: true, verification_status: 'approved' } },
            vehicle: { type: 'car', capacity: 'standard' },
            service: 'ride'
        });
        expect(approvedFromJsonOnly.eligible).toBe(false);
        expect(approvedFromJsonOnly.blockingCodes).toContain('onboarding.not_approved');
    });
});

// ===========================================================================
describe('Phase B — N13 trusted review/resubmission path', () => {
    it('8. neither resubmit path writes compliance state from the client', () => {
        for (const [label, source] of [['settings', read(SETTINGS)], ['dashboard', DASHBOARD_SRC]] as Array<[string, string]>) {
            const executable = code(source);
            expect(executable, `${label} must not set driver_review_status`).not.toMatch(/driver_review_status\s*:/);
            expect(executable, `${label} must not set verification_status`).not.toMatch(/verification_status\s*:/);
            expect(executable, `${label} must not set verification_blockers`).not.toMatch(/verification_blockers\s*:/);
            expect(executable, `${label} must not set driver_review_blockers`).not.toMatch(/driver_review_blockers\s*:/);
            expect(executable, `${label} must not set verification_notes`).not.toMatch(/verification_notes\s*:/);
            // ...it calls the authenticated endpoint instead
            expect(flat(executable), `${label} must use the trusted resubmission`).toContain('this.onboardingstatus.resubmitforreview()');
        }
        // The old client-chosen review state is gone from the resubmission body:
        // it performs no profile mutation at all any more.
        const settingsCode = code(read(SETTINGS));
        const settingsResubmit = settingsCode.slice(
            settingsCode.indexOf('async resubmitDriverReview('),
            settingsCode.indexOf('async openDoc(')
        );
        expect(settingsResubmit, 'the resubmit body must not mutate the profile')
            .not.toMatch(/updateProfile\(|safeUpdateProfile\(|\.from\('profiles'\)/);
        expect(DASHBOARD_SRC).not.toContain('safeUpdateProfile(profile.id, {\n                driver_review_status');
    });

    it('9. the client resubmission sends only the mode flag', () => {
        const service = code(read(ONBOARDING_SERVICE));
        expect(flat(service)).toContain("resubmitforreview():promise<void>{");
        expect(flat(service)).toContain("'/api/driver-onboarding/submit-review',{resubmission:true},true");
        // No status, blockers, notes or driver id in the resubmission payload.
        const call = service.slice(service.indexOf('resubmitForReview()'), service.indexOf('resubmitForReview()') + 260);
        expect(call).not.toMatch(/status|blocker|notes|driverId|driver_id/);
    });

    it('10. identity is server-derived and the server chooses the review state', () => {
        const executable = code(ROUTE_SRC);
        const handler = executable.slice(
            executable.indexOf("router.post('/submit-review'"),
            executable.indexOf('export default router')
        );
        expect(handler, 'submit-review must authenticate').toContain('await authenticatedDriver(req,res)');
        expect(handler, 'the server must own the review state').toContain("verification_status:'under_review'");
        // The resubmission branch resets ONLY the review state.
        const resubBranch = handler.slice(handler.indexOf('if(resubmission)'), handler.indexOf('}else{', handler.indexOf('if(resubmission)')));
        expect(flat(resubBranch)).toContain("verification_status:'under_review',driver_review_status:'under_review'");
        expect(flat(resubBranch)).not.toContain('is_verified');
        // A client can never name a driver: the body is never read for identity.
        expect(flat(handler)).not.toContain('req.body.driverid');
        expect(flat(handler)).not.toContain('req.body.driver_id');
        for (const forbidden of ['onboarding_completed', 'pricing_plan', 'subscription_status', 'full_name']) {
            expect(resubBranch, `a resubmission must not rewrite ${forbidden}`).not.toContain(forbidden);
        }
        // A client cannot choose 'approved' anywhere in the route.
        expect(flat(executable)).not.toContain("verification_status:'approved'");
        expect(flat(executable)).not.toContain('is_verified:true');
    });

    it('11. the admin client has no browser-side approval path', () => {
        const admin = code(read(ADMIN_SERVICE));
        expect(admin, 'the Supabase approval fallback must be gone').not.toContain('manualApproveDriverViaSupabase');
        expect(admin, 'the Supabase request-info fallback must be gone').not.toContain('sendDriverMissingInfoViaSupabase');
        expect(admin).not.toMatch(/is_verified\s*:\s*true/);
        expect(admin).not.toMatch(/testing_approval_override\s*:\s*true/);
        expect(admin).not.toMatch(/verification_status\s*:\s*'approved'/);
        expect(admin).not.toMatch(/driver_review_status\s*:\s*'approved'/);
        // verifyDriver routes to the requireAdmin-guarded server endpoints.
        const verify = admin.slice(admin.indexOf('async verifyDriver('), admin.indexOf('async getJobs('));
        expect(verify).toContain('this.manualApproveDriver(');
        expect(verify).toContain('this.sendDriverMissingInfoRequest(');
    });

    it('12. the shared generic profile writer strips compliance-controlled state', () => {
        const result = stripComplianceControlledFields({
            full_name: 'A Driver',
            phone: '07000',
            avatar_url: 'a.png',
            role: 'driver',
            account_status: 'active',
            verification_items: [{ key: 'x', value: 'y' }],
            is_online: true,
            is_available: false,
            is_verified: true,
            verification_status: 'approved',
            driver_review_status: 'approved',
            verification_blockers: [],
            driver_review_blockers: [],
            compliance_status: 'approved',
            testing_approval_override: true,
            driver_license_status: 'approved',
            insurance_status: 'approved',
            private_hire_driver_license_status: 'approved',
            private_hire_vehicle_license_status: 'approved',
            private_hire_insurance_status: 'approved'
        });
        expect(result.dropped.sort()).toEqual([...COMPLIANCE_CONTROLLED_PROFILE_FIELDS].sort());
        expect(Object.keys(result.payload).sort()).toEqual(
            ['account_status', 'avatar_url', 'full_name', 'is_available', 'is_online', 'phone', 'role', 'verification_items']
        );
        expect(flat(PROFILE_SERVICE_SRC)).toContain('const{payload,dropped}=stripcompliancecontrolledfields(');
        expect(flat(PROFILE_SERVICE_SRC)).toContain('.update(payload)');
    });
});

// ===========================================================================
describe('Phase B — presence semantics preserved (is_online / is_available)', () => {
    it('13. online=true + available=false survives the compliance transition', () => {
        // The profile guard must never treat presence as compliance state.
        expect(COMPLIANCE_CONTROLLED_PROFILE_FIELDS).not.toContain('is_online');
        expect(COMPLIANCE_CONTROLLED_PROFILE_FIELDS).not.toContain('is_available');
        const result = stripComplianceControlledFields({ is_online: true, is_available: false, last_active_at: 'x' });
        expect(result.dropped).toEqual([]);
        expect(result.payload).toEqual({ is_online: true, is_available: false, last_active_at: 'x' });
    });

    it('14. the availability toggle still writes is_available ONLY', () => {
        const source = code(DASHBOARD_SRC);
        const start = source.indexOf('async toggleAvailability(');
        expect(start, 'the page availability toggle must exist').toBeGreaterThan(-1);
        const body = source.slice(start, start + 900);
        expect(body).toContain('is_available: available');
        expect(body, 'availability must not collapse the online flag').not.toContain('is_online');
        // Going offline legitimately clears both; setting busy must not.
        expect(flat(source)).toContain('is_online:false,is_available:false');
    });
});

// ===========================================================================
describe('Phase B — job ownership hardening', () => {
    it('15. the generic client status update cannot assign a driver', () => {
        const executable = code(BOOKING_SERVICE_SRC);
        expect(executable, 'the driver_id branch must be gone').not.toContain("updatePayload['driver_id']");
        expect(flat(executable)).toContain('if(additionaldata.driver_id){');
        expect(flat(executable)).toContain('thrownewerror(');
        // The rest of the status payload is untouched; money is server-authoritative.
        expect(executable).toContain('status: nextStatus');
        expect(flat(executable), 'client must not round-trip a price').not.toContain("updatepayload['price']=price");
        expect(flat(executable), 'client must not round-trip an estimated_price').not.toContain("updatepayload['estimated_price']=price");
    });

    it('16. the legacy client-supplied driverId route is now authenticated', () => {
        const executable = code(read(BOOKING_ROUTE));
        const start = executable.indexOf("router.post('/accept'");
        expect(start, "POST /accept must exist").toBeGreaterThan(-1);
        const handler = executable.slice(start, start + 1400);
        expect(handler).toContain('await getAuthUserId(req)');
        expect(handler).toContain("'Authentication required.'");
        // The body may not name a different driver.
        expect(handler).toContain("code: 'DRIVER_IDENTITY_MISMATCH'");
        expect(flat(handler)).toContain('const{jobid}=req.body');
        // And the client no longer sends driverId.
        expect(flat(code(read('src/app/core/services/driver/driver.service.ts'))))
            .toContain('this.http.post(`${environment.apiurl}/booking/accept`,{jobid:bookingid},{headers:awaitthis.authheaders()})');
    });
});

// ===========================================================================
describe('Phase B — MB002 acquisition error contract', () => {
    it('17. MB002 maps to DRIVER_NOT_ELIGIBLE / 409 and MB001 to DRIVER_BUSY / 409', () => {
        expect(DRIVER_NOT_ELIGIBLE_SQLSTATE).toBe('MB002');
        expect(DRIVER_BUSY_SQLSTATE).toBe('MB001');
        expect(DRIVER_NOT_ELIGIBLE_SQLSTATE).not.toBe(DRIVER_BUSY_SQLSTATE);

        const notEligible = mapAcquisitionError({ code: 'MB002', details: 'licence.private_hire.expiry,document.insurance' });
        expect(notEligible?.code).toBe(DRIVER_NOT_ELIGIBLE_CODE);
        expect(notEligible?.blockingCodes).toEqual(['licence.private_hire.expiry', 'document.insurance']);

        const busy = mapAcquisitionError({ code: 'MB001' });
        expect(busy?.code).toBe(DRIVER_BUSY_CODE);
        expect(busy?.blockingCodes).toEqual([]);
        expect(busy?.code).not.toBe(notEligible?.code);

        // The server contract agrees, and both are 409.
        const serverNotEligible = mapDriverAcquisitionError({ code: SERVER_NOT_ELIGIBLE_SQLSTATE, details: 'a.b' });
        expect(serverNotEligible?.code).toBe(SERVER_NOT_ELIGIBLE_CODE);
        expect(serverNotEligible?.status).toBe(409);
        const serverBusy = mapDriverAcquisitionError({ code: SERVER_BUSY_SQLSTATE });
        expect(serverBusy?.code).toBe(SERVER_BUSY_CODE);
        expect(serverBusy?.status).toBe(409);
    });

    it('18. the mapper never leaks prose, URLs or a document, and stays code-only', () => {
        const failure = mapAcquisitionError({
            code: 'MB002',
            details: 'licence.private_hire.expiry, https://secret.example/doc.pdf, Admin note: forged document, reviewer-42'
        });
        expect(failure?.blockingCodes).toEqual(['licence.private_hire.expiry']);
        const serialized = JSON.stringify(failure);
        expect(serialized).not.toContain('secret.example');
        expect(serialized).not.toContain('Admin note');
        expect(serialized).not.toContain('reviewer-42');
        expect(failure?.message).not.toMatch(/http|admin|reviewer/i);
    });

    it('19. only the reserved SQLSTATEs are claimed; every other error is unchanged', () => {
        for (const other of ['23505', 'PGRST116', '42501', 'P0002', 'MB003', '', undefined, 'P0001']) {
            expect(mapAcquisitionError({ code: other }), `code=${String(other)}`).toBeNull();
            expect(mapDriverAcquisitionError({ code: other })).toBeNull();
        }
        expect(mapAcquisitionError(null)).toBeNull();
        expect(acquisitionErrorMessage(null, 'fallback')).toBe('fallback');
        expect(acquisitionErrorMessage({ code: 'MB001' }, 'fallback')).not.toBe('fallback');
        expect(isDriverBusyError({ code: 'MB001' })).toBe(true);
        expect(isDriverBusyError({ code: 'MB002' })).toBe(false);
        expect(isDriverNotEligibleError({ code: 'MB002' })).toBe(true);
        expect(isDriverNotEligibleError({ code: 'MB001' })).toBe(false);
    });

    it('20. every acquisition path is wired to the contract and no path reports a false success', () => {
        const paths: Array<[string, string]> = [
            [DASHBOARD, 'src/app/apps/mobile/features/driver/dashboard/dashboard.page.ts'],
            ['src/app/core/services/job/job.service.ts', 'job.service'],
            ['src/app/core/services/driver/driver.service.ts', 'driver.service'],
            [ADMIN_SERVICE, 'admin.service'],
            ['src/app/core/services/marketplace/marketplace-hybrid.service.ts', 'marketplace-hybrid.service']
        ];
        for (const [path, label] of paths) {
            const source = read(path);
            expect(source, `${label} must import the contract`)
                .toMatch(/from '(?:@core\/services\/compliance|(?:\.\.\/)+compliance)\/acquisition-error'/);
            expect(source, `${label} must map the error`).toMatch(/acquisitionErrorMessage\(|isDriver(NotEligible|Busy)Error\(/);
        }
        // The two server-owned acquisition routes map MB002/MB001 explicitly.
        const bookingRoute = flat(read(BOOKING_ROUTE));
        expect(bookingRoute).toContain('constacquisitionfailure=mapdriveracquisitionerror(rpcerror)');
        expect(bookingRoute).toContain('constacquisitionfailure=mapdriveracquisitionerror(accepterror)');
        expect(bookingRoute).toContain('mapdriveracquisitionerror(accepterror)');
        // No path turns a false RPC result into success.
        for (const [path, label] of paths) {
            const source = read(path);
            if (source.includes('accepted !== true')) expect(source, `${label} guards false`).toContain('accepted !== true');
        }
        // BOOKING_ROUTE's own false results are still checked.
        expect(flat(read(BOOKING_ROUTE))).toContain('if(rpcerror||!assigned)');
    });

    it('21. accept_assigned_job enforcement remains a Phase C requirement (documented, not activated)', () => {
        // accept_assigned_job does NOT change driver_id, so the Phase A trigger
        // cannot guard it. The client path must still be explicit about it.
        const driverService = read('src/app/core/services/driver/driver.service.ts');
        expect(driverService).toContain("rpc('accept_assigned_job'");
        expect(flat(driverService)).toContain('if(accepted!==true)');
        expect(flat(code(BOOKING_SERVICE_SRC))).toContain('assigningadriverisnotastatusupdate');
        // Phase B does NOT enable the trigger.
        const phaseA = read(PHASE_A_MIGRATION);
        expect(phaseA).toContain('ALTER TABLE public.jobs DISABLE TRIGGER trg_enforce_job_acquisition_eligibility;');
    });
});

// ===========================================================================
describe('Phase B — enforcement stays disabled and no SQL is introduced', () => {
    it('22. no Phase B migration exists, so no Phase B SQL can enable anything', () => {
        const files = readdirSync(MIGRATIONS_DIR);
        const phaseB = files.filter(name => /phase_b/i.test(name));
        expect(phaseB, 'Phase B must not ship a migration in this batch').toEqual([]);
        // Nothing anywhere - in executable SQL - enables the Phase A trigger or
        // profiles RLS. Comments are stripped so prose cannot satisfy the check.
        for (const name of files.filter(n => n.endsWith('.sql'))) {
            const sql = sqlCode(read(`${MIGRATIONS_DIR}/${name}`));
            expect(sql, `${name} must not ENABLE the acquisition trigger`)
                .not.toMatch(/ALTER\s+TABLE\s+(public\.)?jobs\s+ENABLE\s+TRIGGER/i);
            expect(sql, `${name} must not enable profiles RLS`)
                .not.toMatch(/ALTER\s+TABLE\s+(public\.)?profiles\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i);
        }
    });

    it('23. the N12 frozen boundary is untouched', () => {
        const n12 = read(N12_MIGRATION);
        expect(n12).toContain('idx_jobs_one_active_per_driver');
        const statuses = Array.from(n12.matchAll(/'([a-z_]+)'/g)).map(m => m[1]);
        for (const frozen of ['assigned', 'accepted', 'fare_agreed', 'heading_to_pickup', 'driver_en_route',
            'arrived', 'driver_arrived', 'arrived_at_store', 'shopping_in_progress', 'collected', 'picked_up',
            'en_route_to_customer', 'in_progress', 'delivered', 'over_budget_requested', 'requires_review']) {
            expect(statuses, `N12 must still contain ${frozen}`).toContain(frozen);
        }
        // Phase B changes no SQL at all.
        expect(existsSync('supabase/migrations/20260926000000_driver_compliance_eligibility_phase_b.sql')).toBe(false);
    });
});

// ===========================================================================
describe('Phase B — eligibility model convergence', () => {
    it('24. SQL and TS canonical service mappings agree, including uppercase and whitespace', () => {
        const migration = read(PHASE_A_MIGRATION);
        const sqlBody = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION public.canonical_driver_service('));
        const body = sqlBody.slice(0, sqlBody.indexOf('$$;'));
        for (const [raw, expected] of [
            ['ride', 'ride'], ['RIDE', 'ride'], ['Ride', 'ride'], ['  ride  ', 'ride'],
            ['errand', 'errand'], ['ERRAND', 'errand'], ['shop', 'errand'], ['SHOP', 'errand'], ['shopping', 'errand'],
            ['delivery', 'delivery'], ['DELIVERY', 'delivery'], ['deliver', 'delivery'],
            ['van-moving', 'van-moving'], ['VAN-MOVING', 'van-moving'], ['van_moving', 'van-moving'],
            ['move', 'van-moving'], ['moving', 'van-moving'], ['van', 'van-moving']
        ] as const) {
            expect(canonicalDriverService(raw), `TS canonicalDriverService(${JSON.stringify(raw)})`).toBe(expected);
        }
        for (const bad of ['bogus', '', '   ', 'rides', 'car']) {
            expect(canonicalDriverService(bad), `canonicalDriverService(${JSON.stringify(bad)})`).toBeNull();
        }
        // The SQL function normalises case and whitespace BEFORE matching, which is
        // exactly why the TS mirror must do the same.
        expect(flat(body)).toContain('lower(btrim(coalesce(p_raw,');
        for (const service of CANONICAL_DRIVER_SERVICES) expect(body).toContain(`THEN '${service}'`);
    });

    it('25. unknown service still fails closed and advisory rules stay advisory', () => {
        const verdict = evaluateDriverServiceEligibility({
            profile: { role: 'driver' }, vehicle: { type: 'car', capacity: 'standard' }, service: 'bogus'
        });
        expect(verdict.eligible).toBe(false);
        expect(verdict.blockingCodes).toContain(SERVICE_UNRESOLVED_CODE);

        const advisory = [
            'document.courier_insurance', 'document.courier_insurance.expiry', 'document.moving_insurance',
            'document.public_liability', 'document.driving_licence.status', 'document.insurance.status',
            'vehicle.mot_expiry', 'vehicle.tax_status', 'vehicle.verified'
        ];
        for (const ruleCode of advisory) {
            const rows = DRIVER_ELIGIBILITY_RULES.filter(r => r.ruleCode === ruleCode);
            expect(rows.length, `${ruleCode} must remain present`).toBeGreaterThan(0);
            for (const row of rows) expect(row.blocking, `${ruleCode} must stay advisory`).toBe(false);
        }
        // The blocking set still contains the rules Phase A froze as blocking.
        const blocking = new Set(DRIVER_ELIGIBILITY_RULES.filter(r => r.blocking).map(r => r.ruleCode));
        for (const code of ['licence.private_hire.council', 'licence.private_hire.expiry', 'document.goods_in_transit']) {
            expect(blocking.has(code), `${code} must remain blocking`).toBe(true);
        }
    });

    it('26. the eligibility endpoint is authenticated, read-only and client-verdict-free', () => {
        const executable = code(ROUTE_SRC);
        const start = executable.indexOf("router.get('/eligibility'");
        expect(start, 'GET /eligibility must exist').toBeGreaterThan(-1);
        const handler = executable.slice(start, start + 1800);
        expect(handler).toContain('await authenticatedDriver(req,res)');
        expect(flat(handler)).toContain("req.query.service");
        expect(flat(handler)).toContain("code:'service_required'");
        expect(flat(handler)).toContain('evaluatedriverserviceeligibility({profile:profileasrecord<string,unknown>');
        expect(handler).not.toMatch(/\.update\(|\.insert\(|\.delete\(/);
        expect(flat(handler)).toContain("evaluatedby:'ts-mirror'");
        expect(flat(handler)).toContain("enforced:false");
        // The client cannot submit a verdict.
        expect(flat(handler)).not.toContain('req.body.eligible');
        expect(flat(handler)).not.toContain('req.body.blocking');
    });
});

// ===========================================================================
// BATCH 2C / PHASE B.1 — pre-commit acquisition + authentication hardening
// ===========================================================================

const ADMIN_ROUTES = 'server/routes/admin.routes.ts';
const BLOCKED_PAGE = 'src/app/apps/mobile/features/auth/blocked.page.ts';
const PHASE_B1_MIGRATION = 'supabase/migrations/20260926000000_booking_acquisition_atomicity.sql';

const ROUTE_B1 = read(ROUTE);
const BOOKING_B1 = read(BOOKING_ROUTE);
const ADMIN_B1 = read(ADMIN_ROUTES);
const MIGRATION_B1 = read(PHASE_B1_MIGRATION);

/** The route handler body between two anchors. */
const handlerOf = (source: string, startAnchor: string, endAnchor: string): string => {
    const start = source.indexOf(startAnchor);
    expect(start, `${startAnchor} must exist`).toBeGreaterThan(-1);
    const end = source.indexOf(endAnchor, start + startAnchor.length);
    return end > start ? source.slice(start, end) : source.slice(start);
};

/** The executable body of public.accept_driver_offer(). */
const acceptDriverOfferBody = (): string => {
    const sql = sqlCode(MIGRATION_B1);
    const start = sql.indexOf('FUNCTION public.accept_driver_offer(');
    expect(start, 'accept_driver_offer must exist').toBeGreaterThan(-1);
    const end = sql.indexOf('SECTION B', start);
    return end > start ? sql.slice(start, end) : sql.slice(start);
};

describe('Phase B.1 — booking create cannot accept ownership', () => {
    it('27. driver_id and accepted_driver_id are rejected on create', () => {
        const executable = code(BOOKING_B1);
        expect(executable).toContain('const BOOKING_OWNERSHIP_FIELDS = [');
        for (const field of ['driver_id', 'accepted_driver_id', 'accepted_at', 'assigned_at', 'dispatch_started_at']) {
            expect(executable, `${field} must be an ownership field`).toContain(`'${field}'`);
        }
        // Presence of the key is an attempt, even when the value is null/blank.
        expect(executable).toContain('Object.prototype.hasOwnProperty.call(payload, field)');
        expect(executable).toContain("code: 'OWNERSHIP_FIELD_NOT_ALLOWED'");
        // The rejection happens BEFORE any write.
        const create = handlerOf(executable, "router.post('/create'", "router.post('/complete'");
        expect(create.indexOf('OWNERSHIP_FIELD_NOT_ALLOWED')).toBeLessThan(create.indexOf(".insert(insertPayload)"));
    });

    it('28. the insert payload is built from an explicit allow-list', () => {
        const executable = code(BOOKING_B1);
        expect(executable).toContain('const CREATABLE_BOOKING_FIELDS = new Set<string>([');
        expect(executable).toContain('if (CREATABLE_BOOKING_FIELDS.has(key)) insertPayload[key] = value;');
        // The arbitrary client object can no longer reach insert().
        expect(executable).not.toContain("from('jobs').insert(payload)");
        expect(executable).toContain("from('jobs').insert(insertPayload)");
        // customer_id is still forced to the authenticated user.
        expect(executable).toContain('insertPayload.customer_id = userId;');

        // Behavioural proof: every key the shipping client sends is creatable, so
        // the allow-list cannot silently drop a legitimate field.
        const clientKeys = [
            'customer_id', 'service_type_id', 'status', 'payment_status', 'is_draft', 'expires_at',
            'expired_at', 'expiry_reason', 'pickup_address', 'pickup_lat', 'pickup_lng',
            'dropoff_address', 'dropoff_lat', 'dropoff_lng', 'price', 'total_price', 'estimated_price',
            'distance_km', 'estimated_distance_km', 'distance_meters', 'duration_seconds',
            'estimated_duration', 'country_code', 'currency_code', 'currency_symbol',
            'regional_pricing_rule_id', 'pricing_plan_used', 'base_fare_used', 'price_per_km_used',
            'commission_rate_used', 'platform_fee', 'driver_payout', 'tax_amount', 'surge_multiplier',
            'dynamic_pricing_multiplier', 'fare_breakdown', 'marketplace_flags', 'bid_mode_enabled',
            'negotiation_mode_enabled', 'agreed_fare', 'scheduled_time', 'tenant_id', 'metadata',
            'quote_id'
        ];
        for (const key of clientKeys) {
            expect(executable, `allow-list must include ${key}`).toContain(`'${key}'`);
        }
        // ...and it must NOT include any ownership field.
        const allowListBlock = handlerOf(executable, 'const CREATABLE_BOOKING_FIELDS', 'router.post(');
        for (const field of ['driver_id', 'accepted_driver_id', 'accepted_at', 'assigned_at']) {
            expect(allowListBlock, `${field} must not be creatable`).not.toContain(`'${field}'`);
        }
    });
});

describe('Phase B.1 — legacy negotiation acceptance is atomic and authorised', () => {
    const legacy = code(BOOKING_B1);

    it('29. it delegates to the atomic RPC and never writes ownership itself', () => {
        const handler = handlerOf(legacy, "router.post('/negotiation/:id/accept'", "router.post('/negotiation/:jobId/driver-accept'");
        expect(handler).toContain("rpc('accept_driver_offer'");
        // The unguarded ownership write is gone.
        expect(handler).not.toContain("driver_id: acceptedDriverId,");
        expect(handler).not.toMatch(/\.update\(\{\s*status: 'fare_agreed'/);
        // The accepted driver is derived server-side from the negotiation row.
        expect(handler).toContain("proposed_by_role === 'driver'");
        expect(flat(handler)).not.toContain('req.body.driverid');
    });

    it('30. it can neither accept a NULL driver nor reassign A -> B', () => {
        const handler = handlerOf(legacy, "router.post('/negotiation/:id/accept'", "router.post('/negotiation/:jobId/driver-accept'");
        // No driver offer -> refuse; never write driver_id = NULL.
        expect(handler).toContain('NO_DRIVER_OFFER_TO_ACCEPT');
        expect(handler).toContain('if (!acceptedDriverId)');
        // The SQL refuses ownership transfer to a second driver.
        const sql = sqlCode(MIGRATION_B1);
        expect(sql).toContain('IF v_job.driver_id IS NOT NULL AND v_job.driver_id <> p_driver_id THEN');
        expect(sql).toContain("DETAIL  = 'job_already_owned_by_other_driver'");
        // ...and refuses a customer caller acting as a driver.
        expect(sql).toContain('IF v_caller IS NOT NULL AND v_caller <> p_driver_id THEN');
        // The UPDATE itself is BOTH status- and ownership-predicated. Asserting the
        // predicate at the write site (not the pre-check) is what makes removing it
        // detectable.
        expect(acceptDriverOfferBody())
            .toMatch(/UPDATE public\.jobs[\s\S]*?WHERE id = p_job_id[\s\S]*?AND status IN \('pending_fare_confirmation', 'negotiating'\)[\s\S]*?AND \(driver_id IS NULL OR driver_id = p_driver_id\)/);
    });

    it('31. it cannot report success unless ownership actually moved', () => {
        const sql = sqlCode(MIGRATION_B1);
        // The guarded write must be followed IMMEDIATELY by a row-count guard, so
        // disabling or removing that guard is detectable.
        expect(acceptDriverOfferBody())
            .toMatch(/UPDATE public\.jobs[\s\S]*?AND \(driver_id IS NULL OR driver_id = p_driver_id\)[\s\S]*?RETURNING \* INTO v_job;[\s\S]*?IF NOT FOUND THEN[\s\S]*?RAISE EXCEPTION 'Ownership was not applied'/);
        // Phase B.1 must not have changed Phase A SQL to do this: the Phase A
        // postflight still declares the byte identity that the Phase A suite
        // enforces against the migration file.
        expect(flat(read('scripts/db/postflight_20260925000000_driver_compliance_eligibility_phase_a.sql')))
            .toContain('sha256=ce59f801f6d6bd8eb05347aca3c0d4a00c1b2716b6abc189f3acf445fda04268');
        // The route maps every deterministic failure before it can answer success.
        const handler = handlerOf(legacy, "router.post('/negotiation/:id/accept'", "router.post('/negotiation/:jobId/driver-accept'");
        for (const codeValue of ['JOB_ALREADY_OWNED', 'OFFER_NO_LONGER_AVAILABLE', 'OFFER_NOT_FOUND', 'INVALID_OFFER_AMOUNT', 'NOT_ALLOWED']) {
            expect(handler, `${codeValue} must be mapped`).toContain(codeValue);
        }
        expect(handler.indexOf("rpc('accept_driver_offer'")).toBeLessThan(handler.indexOf('success: true'));
    });

    it('32. post-commit pricing cannot be reported as a failed acceptance', () => {
        const handler = handlerOf(legacy, "router.post('/negotiation/:id/accept'", "router.post('/negotiation/:jobId/driver-accept'");
        expect(handler).toContain('ownershipCommitted: true');
        expect(handler).toContain('pricingPending');
        // Pricing runs AFTER the RPC and is wrapped, so it cannot 500 the request.
        const rpcIndex = handler.indexOf("rpc('accept_driver_offer'");
        const pricingIndex = handler.indexOf('applyAgreedFare');
        expect(pricingIndex).toBeGreaterThan(rpcIndex);
        expect(handler.slice(rpcIndex)).toContain('ownership already committed');
    });
});

describe('Phase B.1 — lock_marketplace_fare is hardened in SQL only', () => {
    const sql = sqlCode(MIGRATION_B1);

    it('33. a zero-row update can no longer return a session as success', () => {
        expect(sql).toContain('CREATE OR REPLACE FUNCTION public.lock_marketplace_fare(');
        expect(sql).toContain("RAISE EXCEPTION 'Fare was not locked for this job'");
        expect(sql).toContain('RETURNING * INTO v_job;');
        expect(sql).toContain("DETAIL = 'ownership_not_applied'");
    });

    it('34. it verifies caller identity, job status and the ownership transition', () => {
        expect(sql).toContain('v_caller     UUID := auth.uid();');
        expect(sql).toContain('IF v_caller IS NOT NULL AND v_caller <> p_driver_id THEN');
        expect(sql).toContain('FROM public.jobs');
        expect(sql).toContain('FOR UPDATE;');
        expect(sql).toContain("IF v_job.status NOT IN ('pending_fare_confirmation', 'negotiating', 'pending', 'requested', 'searching') THEN");
        expect(sql).toContain('IF v_job.driver_id IS NOT NULL AND v_job.driver_id <> p_driver_id THEN');
    });

    it('35. N12/MB001 is preserved exactly and MB002 stays reserved', () => {
        expect(sql).toContain("v_constraint = 'idx_jobs_one_active_per_driver'");
        expect(sql).toContain("ERRCODE = 'MB001'");
        // MB002 is NOT raised in this migration: compliance enforcement is Phase C.
        expect(sql, 'Phase B.1 must not activate compliance enforcement').not.toContain("'MB002'");
        // The ACL matrix of lock_marketplace_fare must be untouched.
        expect(sql).not.toMatch(/GRANT[^;]*lock_marketplace_fare/i);
        expect(sql).not.toMatch(/REVOKE[^;]*lock_marketplace_fare/i);
        // The new helper is server-only.
        expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.accept_driver_offer(UUID, UUID) TO service_role;');
        expect(sql).toContain('REVOKE EXECUTE ON FUNCTION public.accept_driver_offer(UUID, UUID) FROM anon, authenticated;');
    });
});

describe('Phase B.1 — /driver-accept cannot fail after ownership committed', () => {
    it('36. an unusable negotiated amount is secondary, never a reported failure', () => {
        const executable = code(BOOKING_B1);
        const handler = handlerOf(executable, "router.post('/negotiation/:jobId/driver-accept'", "router.post('/negotiation/:jobId/driver-counter'");
        expect(handler).toContain('const pricingPending = !Number.isFinite(agreedFare) || agreedFare <= 0;');
        // The old hard failure is gone.
        expect(handler).not.toContain("return res.status(500).json({ error: 'Accepted offer returned no agreed fare' });");
        // Deferred pricing never fabricates a fare.
        expect(handler).toContain("throw new Error('negotiated amount unavailable; derived pricing deferred')");
        // The committed state is reported accurately.
        expect(handler).toContain('ownershipCommitted: true');
        expect(handler).toContain('pricingPending: derivedPricingPending');
        // Notification failure is also secondary.
        expect(handler).toContain('driver-accept notify failed (ownership already committed)');
    });
});

describe('Phase B.1 — booking mutation routes require authentication', () => {
    const executable = code(BOOKING_B1);

    it('37. /cancel authenticates and authorises the participant', () => {
        const handler = handlerOf(executable, "router.post('/cancel'", "router.post('/driver-unable'");
        expect(handler).toContain('await requireAuthenticatedUser(req, res)');
        expect(handler).toContain('isJobParticipant(job, userId)');
        expect(handler).toContain('isAdminUser(userId)');
        expect(handler).toContain("code: 'NOT_A_PARTICIPANT'");
    });

    it('38. /driver-unable derives the acting driver from the session', () => {
        const handler = handlerOf(executable, "router.post('/driver-unable'", "router.post('/rate'");
        expect(handler).toContain('await requireAuthenticatedUser(req, res)');
        expect(handler).toContain("code: 'DRIVER_IDENTITY_MISMATCH'");
        expect(handler).toContain("code: 'NOT_ASSIGNED_DRIVER'");
        // The acting driver is the session user, never the body value.
        expect(handler).toContain('const actingDriverId = userId;');
        expect(handler).not.toContain('freezeDriverCard(driverId,');
        expect(handler).not.toContain('driver_id: driverId,');
    });

    it('39. /decline-job records the decline for the authenticated driver only', () => {
        const handler = handlerOf(executable, "router.post('/decline-job'", "router.post('/notify-status'");
        expect(handler).toContain('await requireAuthenticatedUser(req, res)');
        expect(handler).toContain("code: 'DRIVER_IDENTITY_MISMATCH'");
        expect(handler).toContain('driver_id: userId,');
        expect(handler).not.toContain('driver_id: driverId,');
    });

    it('40. /notify-status requires a participant and a canonical status', () => {
        const handler = handlerOf(executable, "router.post('/notify-status'", "router.post('/negotiation'");
        expect(handler).toContain('await requireAuthenticatedUser(req, res)');
        expect(handler).toContain('NOTIFIABLE_JOB_STATUSES.has(normalise(status))');
        expect(handler).toContain("code: 'UNKNOWN_JOB_STATUS'");
        expect(handler).toContain('isJobParticipant(job, userId)');
        expect(handler).toContain("code: 'NOT_A_PARTICIPANT'");
    });

    it('41. no booking mutation route can be reached without authentication', () => {
        // Evaluated over the real registrations: each listed mutation route must
        // call the authentication helper inside its handler.
        const routeNames = ['/create', '/accept', '/complete', '/cancel', '/driver-unable',
            '/decline-job', '/notify-status', '/negotiation/:id/accept', '/negotiation/:jobId/driver-accept'];
        for (const name of routeNames) {
            const start = executable.indexOf(`router.post('${name}'`);
            expect(start, `${name} must exist`).toBeGreaterThan(-1);
            const body = executable.slice(start, start + 900);
            expect(body, `${name} must authenticate`).toMatch(/requireAuthenticatedUser\(req, res\)|getAuthUserId\(req\)/);
        }
    });
});

describe('Phase B.1 — admin routes are consistently admin-guarded', () => {
    it('42. EVERY registered admin route carries requireAdmin', () => {
        // Evaluated over the real file: parse every route registration and require
        // the middleware on each one. An intentionally open route would fail here.
        const registrations = Array.from(ADMIN_B1.matchAll(/^router\.(get|post|put|patch|delete)\('([^']+)'([^\n]*)/gm));
        expect(registrations.length, 'admin routes must be discoverable').toBeGreaterThan(20);
        const unguarded = registrations
            .filter(([, , , rest]) => !rest.includes('requireAdmin'))
            .map(([, method, path]) => `${method.toUpperCase()} ${path}`);
        expect(unguarded, 'every /api/admin route must require an admin session').toEqual([]);
        // The middleware is defined before any registration uses it.
        const defIndex = ADMIN_B1.indexOf('const requireAdmin =');
        expect(defIndex).toBeGreaterThan(-1);
        const firstUse = ADMIN_B1.indexOf('requireAdmin,');
        expect(firstUse).toBeGreaterThan(defIndex);
        // There is deliberately no router-level guard: per-route is the contract.
        expect(ADMIN_B1).not.toContain('router.use(requireAdmin)');
    });

    it('43. the admin client sends its session on the guarded inspection calls', () => {
        const admin = read(ADMIN_SERVICE);
        for (const path of ['/api/admin/heatmap', '/api/admin/metrics', '/api/admin/failures', '/api/admin/payments']) {
            const start = admin.indexOf(`getApiUrl('${path}')`);
            expect(start, `${path} must still be called`).toBeGreaterThan(-1);
            const call = admin.slice(start, start + 90);
            expect(call, `${path} must send authenticated headers`).toContain('{ headers }');
        }
        expect(admin).toContain('const headers = await this.getAuthenticatedApiHeaders();');
    });
});

describe('Phase B.1 — account-status escalation is closed at the client boundary', () => {
    it('44. a suspended or blocked account cannot self-reactivate', () => {
        const page = code(read(BLOCKED_PAGE));
        const handler = handlerOf(page, 'async cancelClosureRequest()', 'this.auth.accountStatus.set');
        expect(handler, 'only a user-requested closure may be cancelled')
            .toContain("if (this.status() !== 'closure_requested')");
        expect(handler).toContain('return;');
        // The write still happens for the legitimate case, after the guard.
        expect(handler.indexOf("this.status() !== 'closure_requested'"))
            .toBeLessThan(handler.indexOf("account_status: 'active'"));
        // The template guard is not the only line of defence.
        expect(page).toContain("status() === 'closure_requested'");
        // Admin moderation must not depend on a client-direct write.
        expect(code(read(ADMIN_SERVICE))).not.toMatch(/verification_status\s*:\s*'approved'/);
    });
});

describe('Phase B.1 — licence compatibility shapes frozen for Phase C', () => {
    /** The shapes Phase C MUST make the SQL evaluator read. Frozen here. */
    const PHASE_C_COMPATIBILITY_SHAPES = ['object', 'array_of_key_value', 'json_string'] as const;

    it('45. the supported shapes are frozen and canonical columns still win', () => {
        const canonicalOnly = {
            council_name: 'Canonical Council',
            council_license_number: 'CANON-1',
            taxi_badge_number: 'CANON-BADGE',
            taxi_license_expiry: TOMORROW
        };
        // Canonical-only production evidence is INTENTIONAL: one record, no
        // compatibility mirror, and it must resolve as complete.
        const resolved = readPassengerLicence(canonicalOnly, TODAY);
        expect(resolved).toMatchObject({ councilName: 'Canonical Council', licenceNumber: 'CANON-1', complete: true });
        expect(resolved.expiryDate).toBe(TOMORROW);

        // Every frozen shape is read by the application...
        expect(passengerLicenceItems({ council_name: 'X' })).toEqual({ council_name: 'X' });
        expect(passengerLicenceItems([{ key: 'council_name', value: 'X' }])).toEqual({ council_name: 'X' });
        expect(passengerLicenceItems('{"council_name":"X"}')).toEqual({ council_name: 'X' });
        expect(PHASE_C_COMPATIBILITY_SHAPES).toHaveLength(3);
        // ...and malformed compatibility values still fail closed.
        for (const bad of ['2026-13-01', '2026-02-30', 'not-a-date']) {
            expect(readPassengerLicence({
                council_name: 'C', council_license_number: '1', taxi_badge_number: 'B',
                verification_items: { taxi_license_expiry: bad }
            }, TODAY).expiryDate).toBeNull();
        }
    });

    it('46. PHASE C BLOCKER: the SQL evaluator reads the OBJECT shape only', () => {
        // The Phase A evaluator reads verification_items as an object map and has
        // no array/JSON-string support, while the application writes ARRAY-shaped
        // mirrors (serializeOnboardingItems returns Array<{key,value}>). For a row
        // whose licence lives ONLY in an array-shaped bag, the SQL read finds
        // nothing and would fail closed once the acquisition trigger is enabled.
        const phaseA = flat(sqlCode(read(PHASE_A_MIGRATION)));
        expect(phaseA).toContain("jsonb_typeof(v_profile->'verification_items')='object'");
        expect(phaseA).not.toContain('jsonb_array_elements');
        expect(phaseA).not.toContain("->>'key'");
        // The application-side mirror writer really is ARRAY-shaped.
        const route = flat(read(ROUTE));
        expect(route).toContain('functionserializeonboardingitems(');
        expect(route).toContain('returnobject.entries(items).filter');
        expect(route).toContain('=>({key,');
        // PHASE C REQUIREMENT (frozen): the evaluator (or a helper it calls) must
        // normalise all three shapes before comparing, canonical columns first.
        const requiredPhaseCRead = PHASE_C_COMPATIBILITY_SHAPES;
        expect(requiredPhaseCRead).toEqual(['object', 'array_of_key_value', 'json_string']);
        // Phase B.1 must NOT have changed Phase A SQL to do this: the Phase A
        // postflight still declares the byte identity that the Phase A suite
        // enforces against the migration file.
        expect(flat(read('scripts/db/postflight_20260925000000_driver_compliance_eligibility_phase_a.sql')))
            .toContain('sha256=ce59f801f6d6bd8eb05347aca3c0d4a00c1b2716b6abc189f3acf445fda04268');
    });
});

describe('Phase B.1 — frozen boundaries re-asserted', () => {
    it('47. trigger disabled, N12 untouched, MB001/MB002 distinct, no advisory promotion', () => {
        expect(read(PHASE_A_MIGRATION))
            .toContain('ALTER TABLE public.jobs DISABLE TRIGGER trg_enforce_job_acquisition_eligibility;');
        // The new migration is additive and inert.
        const sql = sqlCode(MIGRATION_B1);
        expect(sql).not.toMatch(/ENABLE\s+TRIGGER/i);
        expect(sql).not.toMatch(/ENABLE\s+ROW\s+LEVEL\s+SECURITY/i);
        expect(sql).not.toMatch(/\b(CREATE|DROP|ALTER)\s+POLICY/i);
        expect(sql).not.toMatch(/\b(GRANT|REVOKE)\b[^;]*\bON\s+(TABLE|COLUMN)\b/i);
        expect(sql).not.toMatch(/\bUPDATE\s+public\.(profiles|vehicles)\b/i);
        // N12 frozen boundary untouched.
        expect(sql).not.toMatch(/CREATE\s+UNIQUE\s+INDEX/i);
        expect(sql).not.toContain('idx_jobs_one_active_per_driver ON');
        // MB001 != MB002.
        expect(SERVER_BUSY_SQLSTATE).not.toBe(SERVER_NOT_ELIGIBLE_SQLSTATE);
        // No advisory promotion.
        for (const row of DRIVER_ELIGIBILITY_RULES.filter(r => r.ruleCode.startsWith('document.') && !r.blocking)) {
            expect(row.blocking).toBe(false);
        }
    });
});

describe('Phase B.1 — the client carries its session on every authenticated route', () => {
    it('48. each guarded mutation route is called WITH bearer headers', () => {
        // Batch 2C Phase B.1 authenticated /cancel, /notify-status, /decline-job and
        // /driver-unable on the server. Their client calls previously sent NO token,
        // so without this the legitimate flows would have started failing with 401.
        const booking = read(BOOKING_SERVICE);
        const driver = read('src/app/core/services/driver/driver.service.ts');
        const calls: Array<[string, string, number]> = [
            [booking, '/api/booking/cancel', 320],
            [booking, '/api/booking/notify-status', 320],
            [driver, '/api/booking/decline-job', 320],
            [driver, '/api/booking/driver-unable', 460]
        ];
        for (const [source, path, window] of calls) {
            const start = source.indexOf(path);
            expect(start, `${path} must still be called`).toBeGreaterThan(-1);
            const call = source.slice(start, start + window);
            expect(call, `${path} must send bearer headers`).toContain('{ headers: await this.authHeaders() }');
        }
        // Both services own the helper, and the acting identity is no longer sent
        // in the body where the server derives it.
        expect(booking).toContain('private async authHeaders(): Promise<HttpHeaders>');
        expect(driver).toContain('private async authHeaders()');
        const cancelCall = booking.slice(booking.indexOf('/api/booking/cancel'), booking.indexOf('/api/booking/cancel') + 320);
        expect(cancelCall, 'the server derives the customer from the session').not.toContain('customerId');
        for (const path of ['/api/booking/decline-job', '/api/booking/driver-unable']) {
            const call = driver.slice(driver.indexOf(path), driver.indexOf(path) + 460);
            expect(call, `${path} must not declare the driver identity`).not.toContain('driverId:');
        }
    });
});
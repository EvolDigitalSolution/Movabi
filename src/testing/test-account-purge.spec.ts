import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isTestAccountPurgeEnabled } from '../../server/services/test-account-purge.service';

const service = readFileSync(resolve(process.cwd(), 'server/services/test-account-purge.service.ts'), 'utf8');
const adminRoutes = readFileSync(resolve(process.cwd(), 'server/routes/admin.routes.ts'), 'utf8');
const adminService = readFileSync(resolve(process.cwd(), 'src/app/apps/admin/services/admin.service.ts'), 'utf8');
const userList = readFileSync(resolve(process.cwd(), 'src/app/apps/admin/features/users/user-list.component.ts'), 'utf8');
const driverList = readFileSync(resolve(process.cwd(), 'src/app/apps/admin/features/drivers/driver-list.component.ts'), 'utf8');

describe('test account purge feature gate', () => {
    it('fails closed when missing, false, or malformed', () => {
        expect(isTestAccountPurgeEnabled({})).toBe(false);
        expect(isTestAccountPurgeEnabled({ ALLOW_ADMIN_TEST_ACCOUNT_PURGE: 'false' })).toBe(false);
        expect(isTestAccountPurgeEnabled({ ALLOW_ADMIN_TEST_ACCOUNT_PURGE: '1' })).toBe(false);
        expect(isTestAccountPurgeEnabled({ ALLOW_ADMIN_TEST_ACCOUNT_PURGE: 'yes' })).toBe(false);
    });

    it('enables only when exactly true (trimmed, case-insensitive)', () => {
        expect(isTestAccountPurgeEnabled({ ALLOW_ADMIN_TEST_ACCOUNT_PURGE: 'true' })).toBe(true);
        expect(isTestAccountPurgeEnabled({ ALLOW_ADMIN_TEST_ACCOUNT_PURGE: ' TRUE ' })).toBe(true);
    });
});

describe('test account purge server implementation', () => {
    it('endpoint is requireAdmin-gated and feature-flagged', () => {
        expect(adminRoutes).toContain("router.post('/test-account/purge', requireAdmin");
        expect(adminRoutes).toContain('isTestAccountPurgeEnabled()');
        expect(adminRoutes).toContain('TEST_ACCOUNT_PURGE_DISABLED');
    });

    it('validates UUID and refuses self/admin', () => {
        expect(adminRoutes).toContain("code: 'INVALID_USER_ID'");
        expect(service).toContain('CANNOT_PURGE_SELF');
        expect(service).toContain('CANNOT_PURGE_ADMIN');
    });

    it('deletes the affected job aggregate (no history 409 blocker)', () => {
        expect(service).toContain('collectAffectedJobIds');
        expect(service).toContain('accepted_driver_id');
        expect(service).toContain('JOB_OWNED_TABLES');
        expect(service).not.toContain('TEST_ACCOUNT_HAS_HISTORY');
    });

    it('hard-deletes the Auth identity and releases registration blockers', () => {
        expect(service).toContain('deleteUser(targetUserId, false)');
        expect(service).toContain("registration_otps', 'email'");
        expect(service).toContain("profiles').delete().eq('id', targetUserId)");
    });

    it('does not delete Stripe live resources (no Stripe mutation call)', () => {
        expect(service).not.toContain('stripe.customers');
        expect(service).not.toContain('stripe.accounts');
    });
});

describe('admin purge UI', () => {
    it('Admin service calls the server endpoint', () => {
        expect(adminService).toContain('/api/admin/test-account/purge');
        expect(adminService).toContain('purgeTestAccount');
    });

    it('Admin Users exposes typed DELETE confirmation', () => {
        expect(userList).toContain('openPurgeModal');
        expect(userList).toContain("purgeConfirmText() !== 'DELETE'");
        expect(userList).toContain('associated test activity. This cannot be undone');
    });

    it('Admin Drivers exposes typed DELETE confirmation', () => {
        expect(driverList).toContain('openPurgeModal');
        expect(driverList).toContain("purgeConfirmText() !== 'DELETE'");
        expect(driverList).toContain('associated test activity. This cannot be undone');
    });
});

describe('negotiation orphan cleanup', () => {
    it('deletes marketplace_negotiation_events by session_id before parent sessions', () => {
        expect(service).toContain('deleteNegotiationEventsForJobs');
        expect(service).toContain("marketplace_negotiation_sessions').select('id').in('job_id'");
        expect(service).toContain("marketplace_negotiation_events', 'session_id'");
    });

    it('is invoked in both individual purge and reset-all paths', () => {
        // Occurrences: helper definition + both call sites.
        expect(service.match(/deleteNegotiationEventsForJobs\(/g)?.length).toBeGreaterThanOrEqual(3);
    });

    it('preserves account-level proposed_by cleanup for target-owned orphans', () => {
        expect(service).toContain("{ table: 'marketplace_negotiation_events', column: 'proposed_by' }");
    });
});

describe('production FK coverage', () => {
    it('deletes NO ACTION job_locations.driver_id before Auth', () => {
        expect(service).toContain("{ table: 'job_locations', column: 'driver_id' }");
    });

    it('deletes driver_onboarding_notifications (CASCADE) explicitly', () => {
        expect(service).toContain("{ table: 'driver_onboarding_notifications', column: 'driver_id' }");
    });

    it('deletes job detail tables (ride/delivery/van/errand)', () => {
        expect(service).toContain("{ table: 'ride_details', column: 'job_id' }");
        expect(service).toContain("{ table: 'delivery_details', column: 'job_id' }");
        expect(service).toContain("{ table: 'van_details', column: 'job_id' }");
        expect(service).toContain("{ table: 'errand_details', column: 'job_id' }");
    });

    it('deletes affected jobs before Auth hard-delete (NO ACTION ordering)', () => {
        const jobsDeleteIndex = service.indexOf("deleteWhereIn('jobs', 'id', affectedJobIds)");
        const mainAuthDeleteIndex = service.lastIndexOf('deleteUser(targetUserId, false)');
        expect(jobsDeleteIndex).toBeGreaterThan(-1);
        expect(mainAuthDeleteIndex).toBeGreaterThan(-1);
        expect(jobsDeleteIndex).toBeLessThan(mainAuthDeleteIndex);
    });

    it('deletes NO ACTION account references (subscriptions/earnings/messages/ratings/history)', () => {
        expect(service).toContain("{ table: 'subscriptions', column: 'user_id' }");
        expect(service).toContain("{ table: 'driver_earnings', column: 'driver_id' }");
        expect(service).toContain("{ table: 'job_messages', column: 'sender_id' }");
        expect(service).toContain("{ table: 'job_messages', column: 'receiver_id' }");
        expect(service).toContain("{ table: 'job_events', column: 'actor_id' }");
        expect(service).toContain("{ table: 'ratings', column: 'customer_id' }");
        expect(service).toContain("{ table: 'booking_status_history', column: 'changed_by' }");
    });
});

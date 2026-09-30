import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    isResetAllTestDataEnabled,
    createResetChallenge,
    consumeResetChallenge,
    RESET_ALL_CONFIRMATION
} from '../../server/services/test-account-purge.service';

const service = readFileSync(resolve(process.cwd(), 'server/services/test-account-purge.service.ts'), 'utf8');
const adminRoutes = readFileSync(resolve(process.cwd(), 'server/routes/admin.routes.ts'), 'utf8');
const adminService = readFileSync(resolve(process.cwd(), 'src/app/apps/admin/services/admin.service.ts'), 'utf8');
const settings = readFileSync(resolve(process.cwd(), 'src/app/apps/admin/features/settings/settings.component.ts'), 'utf8');

describe('reset all test data gate', () => {
    it('fails closed unless exactly true', () => {
        expect(isResetAllTestDataEnabled({})).toBe(false);
        expect(isResetAllTestDataEnabled({ ALLOW_ADMIN_RESET_ALL_TEST_DATA: 'false' })).toBe(false);
        expect(isResetAllTestDataEnabled({ ALLOW_ADMIN_RESET_ALL_TEST_DATA: 'true' })).toBe(true);
    });
});

describe('reset challenge', () => {
    it('is single-use and admin-bound', () => {
        const { challengeId } = createResetChallenge('admin-1');
        expect(challengeId).toBeTruthy();
        expect(consumeResetChallenge(challengeId, 'admin-1')).toBe(true);
        expect(consumeResetChallenge(challengeId, 'admin-1')).toBe(false); // replay
    });

    it('rejects another admin using the challenge', () => {
        const { challengeId } = createResetChallenge('admin-1');
        expect(consumeResetChallenge(challengeId, 'admin-2')).toBe(false);
    });

    it('rejects an unknown challenge', () => {
        expect(consumeResetChallenge('does-not-exist', 'admin-1')).toBe(false);
    });

    it('requires the exact confirmation phrase', () => {
        expect(RESET_ALL_CONFIRMATION).toBe('RESET ALL TEST DATA');
    });
});

describe('reset all test data implementation', () => {
    it('endpoints are requireAdmin-gated and double feature-flagged', () => {
        expect(adminRoutes).toContain("router.post('/test-data/reset/prepare', requireAdmin");
        expect(adminRoutes).toContain("router.post('/test-data/reset/execute', requireAdmin");
        expect(adminRoutes).toContain('isResetAllTestDataEnabled()');
        expect(adminRoutes).toContain('RESET_ALL_TEST_DATA_DISABLED');
    });

    it('execute validates confirmation phrase and challenge', () => {
        expect(adminRoutes).toContain('INVALID_CONFIRMATION');
        expect(adminRoutes).toContain('INVALID_CHALLENGE');
        expect(adminRoutes).toContain('consumeResetChallenge(challengeId, adminUserId)');
    });

    it('targets only non-admin accounts (preserves admins)', () => {
        expect(service).toContain("String(row.role || '').trim().toLowerCase() !== 'admin'");
        expect(service).not.toContain('TRUNCATE');
    });

    it('hard-deletes Auth users and reuses the shared job-aggregate deletion', () => {
        expect(service).toContain('resetAllTestData');
        expect(service).toContain('deleteUser(id, false)');
        expect(service).toContain('JOB_OWNED_TABLES');
        expect(service).toContain('ACCOUNT_OWNED_TABLES');
    });

    it('Admin service exposes prepare/execute methods', () => {
        expect(adminService).toContain('/api/admin/test-data/reset/prepare');
        expect(adminService).toContain('/api/admin/test-data/reset/execute');
        expect(adminService).toContain('prepareResetAllTestData');
        expect(adminService).toContain('executeResetAllTestData');
    });
});

describe('reset targeting, audit, partial-failure and UI', () => {
    it('targets NULL/blank/non-admin roles and preserves only admin', () => {
        expect(service).toContain(".filter((row) => String(row.role || '').trim().toLowerCase() !== 'admin')");
        expect(service).not.toContain(".neq('role', 'admin')");
    });

    it('writes a durable admin audit entry that survives the reset', () => {
        expect(adminRoutes).toContain('AuditService.log');
        expect(adminRoutes).toContain('admin_reset_all_test_data');
        expect(adminRoutes).toContain('accountsRemoved');
    });

    it('reports Auth and storage partial failures (no false success)', () => {
        expect(service).toContain('authDeletionFailures');
        expect(service).toContain('storageFailures');
        expect(service).toContain('authDeletionFailures += 1');
    });

    it('Admin Settings wires prepare/execute with typed phrase + preview', () => {
        expect(settings).toContain('openResetPreview');
        expect(settings).toContain('executeReset');
        expect(settings).toContain("'RESET ALL TEST DATA'");
        expect(settings).toContain('resetPreviewData()?.accounts');
    });
});

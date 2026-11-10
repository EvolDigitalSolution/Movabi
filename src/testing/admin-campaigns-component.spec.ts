// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { provideZonelessChangeDetection } from '@angular/core';

TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
import { AdminCampaignsComponent } from '../app/apps/admin/features/finance/admin-campaigns.component';
import { AdminService } from '../app/apps/admin/services/admin.service';

const createCampaign = vi.fn();
const editCampaign = vi.fn();
const setCampaignStatus = vi.fn();
const listCampaigns = vi.fn();
const campaignAudit = vi.fn();
const previewVayduMargin = vi.fn();

function setup() {
    createCampaign.mockReset(); editCampaign.mockReset(); setCampaignStatus.mockReset();
    listCampaigns.mockReset().mockResolvedValue([]);
    campaignAudit.mockReset().mockResolvedValue([]);
    previewVayduMargin.mockReset().mockResolvedValue({ vayduMarginMinor: 43, marginBps: 1351 });
    TestBed.configureTestingModule({
        imports: [AdminCampaignsComponent],
        providers: [provideZonelessChangeDetection(), {
            provide: AdminService,
            useValue: { listCampaigns, createCampaign, editCampaign, setCampaignStatus, campaignAudit, previewVayduMargin }
        }]
    });
    const f = TestBed.createComponent(AdminCampaignsComponent);
    return f;
}

async function stable(f: ComponentFixture<AdminCampaignsComponent>) { await f.whenStable(); f.detectChanges(); }

describe('admin campaigns component', () => {
    it('renders create, lifecycle and margin-preview controls', async () => {
        const f = setup();
        listCampaigns.mockResolvedValue([{ id: 'c1', code: 'PROMO', kind: 'customer_discount', market_code: 'GB', currency_code: 'GBP', service_slug: 'ride', audience: 'customer', enabled: true, paused: false, version: 1, value_type: 'percent', value: 5, referral_reward_bps: 500, budget_minor: 0, per_user_cap: 1, usage_limit: null, stacking: 'exclusive', qualification: {}, tenant_id: 't1' }]);
        await stable(f);
        const text = f.nativeElement.textContent;
        expect(text).toContain('Campaigns');
        expect(text).toContain('Create');
        expect(text).toContain('Margin preview');
        expect(text).toContain('Enable');
        expect(text).toContain('Pause');
        expect(text).toContain('Disable');
    });

    it('create sends the approved 5% + 500bps defaults', async () => {
        const f = setup(); await stable(f);
        const c = f.componentInstance;
        c.form.tenantId = 't1'; c.form.code = 'WELCOME5';
        await c.save(); await stable(f);
        expect(createCampaign).toHaveBeenCalledTimes(1);
        const payload = createCampaign.mock.calls[0][0];
        expect(payload.value).toBe(5);
        expect(payload.referral_reward_bps).toBe(500);
        expect(payload.value_type).toBe('percent');
    });

    it('edit loads a campaign and save creates a new version', async () => {
        const f = setup(); await stable(f);
        const row = { id: 'c1', code: 'PROMO', kind: 'customer_discount', market_code: 'GB', currency_code: 'GBP', service_slug: 'ride', audience: 'customer', enabled: true, paused: false, version: 2, value_type: 'percent', value: 5, referral_reward_bps: 500, budget_minor: 0, per_user_cap: 1, usage_limit: null, stacking: 'exclusive', funding_party: 'platform', qualification: { firstBookingOnly: true, min_qualifying_fare_minor: 100 }, tenant_id: 't1' };
        const c = f.componentInstance;
        c.edit(row as any);
        expect(c.editingId).toBe('c1');
        c.form.value = 7; // rate edit
        await c.save(); await stable(f);
        expect(editCampaign).toHaveBeenCalledTimes(1);
        expect(editCampaign.mock.calls[0][0]).toBe('c1');
        expect(editCampaign.mock.calls[0][1].value).toBe(7);
    });

    it('setStatus drives the tri-state lifecycle', async () => {
        const f = setup(); await stable(f);
        const row = { id: 'c1', code: 'PROMO', kind: 'customer_discount', market_code: 'GB', currency_code: 'GBP', service_slug: 'ride', audience: 'customer', enabled: true, paused: false, version: 1, value_type: 'percent', value: 5, referral_reward_bps: 500, budget_minor: 0, per_user_cap: 1, usage_limit: null, stacking: 'exclusive', qualification: {}, tenant_id: 't1' };
        await f.componentInstance.setStatus(row as any, 'paused');
        await stable(f);
        expect(setCampaignStatus).toHaveBeenCalledWith('c1', 'paused');
    });

    it('validation blocks a save without tenant or code', async () => {
        const f = setup(); await stable(f);
        const c = f.componentInstance;
        c.form.tenantId = ''; c.form.code = '';
        await c.save(); await stable(f);
        expect(createCampaign).not.toHaveBeenCalled();
        expect(c.validationError()).toBe('Tenant and code are required.');
    });
});

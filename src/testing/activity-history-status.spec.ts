/**
 * Activity history — cancelled Shop (errand) status display + load lifecycle.
 *
 * Drives the REAL ActivityPage methods (not source text):
 *   - a cancelled job renders "Cancelled", never the old pending "Updating…"
 *   - both the stored British spelling (`cancelled`, the only one accepted by
 *     jobs_status_check) and the American spelling map to "Cancelled"
 *   - refund/payment state is shown SEPARATELY from the status badge
 *   - an unknown/missing status stays neutral (never assumed to be a cancellation)
 *   - the loading flag is cleared on success AND on error
 */
import '@angular/compiler';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const M = vi.hoisted(() => ({
  history: [] as any[],
  pending: [] as any[],
  getHistory: vi.fn()
}));

// The page imports IonicModule and shared UI components; @ionic/angular's ESM
// loader cannot resolve under the node test environment and the class under test
// does not need any of them.
vi.mock('@ionic/angular', () => ({ IonicModule: class IonicModule {} }));
vi.mock('@ionic/angular/standalone', () => ({}));
// @angular/router pulls in PlatformLocation, which needs the JIT compiler here.
vi.mock('@angular/router', () => ({ Router: class Router {} }));
vi.mock('@angular/common', () => ({ CommonModule: class CommonModule {} }));
vi.mock('../app/shared/ui', () => ({ CardComponent: class {}, BadgeComponent: class {} }));
vi.mock('../app/shared/components/customer-shell/customer-bottom-nav.component', () => ({
  CustomerBottomNavComponent: class {}
}));

import { ActivityPage } from '../app/apps/mobile/features/customer/activity/activity.page';

/**
 * A real ActivityPage instance without Angular DI: the status/payment helpers are
 * pure, and loadHistory only touches the loading/error signals + the booking
 * service, so the prototype is driven directly.
 */
function makePage() {
  const page = Object.create(ActivityPage.prototype) as any;
  page.isLoadingHistory = signal(true);
  page.historyError = signal<string | null>(null);
  page.bookingService = { getHistory: M.getHistory };
  return page as ActivityPage & {
    isLoadingHistory: { (): boolean };
    historyError: { (): string | null };
  };
}

describe('activity history status display', () => {
  beforeEach(() => {
    M.history = [];
    M.pending = [];
    M.getHistory.mockReset();
  });

  it('renders a cancelled Shop (errand) job as "Cancelled", not "Updating…"', () => {
    const page = makePage();
    expect(page.formatStatus('cancelled')).toBe('Cancelled');
    expect(page.formatStatus('cancelled')).not.toBe('Updating…');
  });

  it('treats the American spelling as the same terminal cancellation', () => {
    const page = makePage();
    expect(page.formatStatus('canceled')).toBe('Cancelled');
    expect(page.formatStatus('CANCELLED')).toBe('Cancelled');
  });

  it('maps the other terminal statuses instead of leaving them pending', () => {
    const page = makePage();
    expect(page.formatStatus('completed')).toBe('Completed');
    expect(page.formatStatus('settled')).toBe('Settled');
    expect(page.formatStatus('failed')).toBe('Failed');
    expect(page.formatStatus('no_driver_found')).toBe('No driver found');
  });

  it('never assumes an unknown or missing status is a cancellation', () => {
    const page = makePage();
    for (const raw of ['brand_new_status', '', undefined, null]) {
      const label = page.formatStatus(raw as string | undefined);
      expect(label).toBe('Unknown status');
      expect(label).not.toBe('Cancelled');
      expect(label).not.toBe('Updating…');
    }
  });

  it('does not de-underscore an unknown status into raw internals', () => {
    const page = makePage();
    expect(page.formatStatus('brand_new_status')).not.toContain('brand new status');
  });
});

describe('activity history payment/refund state', () => {
  beforeEach(() => {
    M.history = [];
    M.pending = [];
    M.getHistory.mockReset();
  });

  const cancelledShopJob = (extra: Record<string, unknown> = {}) =>
    ({ id: 'job-1', service_slug: 'errand', status: 'cancelled', ...extra }) as any;

  it('shows a refund separately from the Cancelled badge', () => {
    const page = makePage();
    expect(page.paymentStateLabel(cancelledShopJob({ payment_status: 'refunded' }))).toBe('Refunded');
  });

  it('distinguishes a completed full refund from a partial refund', () => {
    const page = makePage();
    // Full: the server only writes payment_status='refunded' when
    // requestedMinor >= capturedMinor (payment.routes.ts).
    expect(page.paymentStateLabel(cancelledShopJob({
      payment_status: 'refunded', refund_id: 're_full', total_refunded_minor: 350
    }))).toBe('Refunded');

    // Partial: a refund exists but the status stays paid.
    expect(page.paymentStateLabel(cancelledShopJob({
      payment_status: 'paid', refund_id: 're_part', total_refunded_minor: 175
    }))).toBe('Partially refunded');
    expect(page.paymentStateLabel(cancelledShopJob({
      payment_status: 'paid', refund_id: 're_part'
    }))).toBe('Partially refunded');
  });

  it('shows a refund that has not been issued yet as pending', () => {
    const page = makePage();
    expect(page.paymentStateLabel(cancelledShopJob({ payment_status: 'requires_refund' }))).toBe('Refund pending');
    // Pending wins over any stale refund signal.
    expect(page.paymentStateLabel(cancelledShopJob({
      payment_status: 'requires_refund', refund_id: 're_stale'
    }))).toBe('Refund pending');
  });

  it('reports an uncharged cancelled job as "Payment pending"', () => {
    const page = makePage();
    expect(page.paymentStateLabel(cancelledShopJob({ payment_status: 'pending' }))).toBe('Payment pending');
    expect(page.paymentStateLabel(cancelledShopJob())).toBe('Payment pending');
    expect(page.paymentStateLabel(cancelledShopJob({ payment_status: 'pending' }))).not.toBe('No charge taken');
  });

  it('does not show a payment state for a non-terminal job', () => {
    const page = makePage();
    expect(page.paymentStateLabel({ status: 'in_progress' } as any)).toBeNull();
    expect(page.paymentStateLabel({ status: 'shopping_in_progress' } as any)).toBeNull();
  });
});

describe('activity history load lifecycle', () => {
  beforeEach(() => {
    M.history = [];
    M.pending = [];
    M.getHistory.mockReset();
  });

  it('clears the loading flag after a successful load', async () => {
    M.getHistory.mockResolvedValue(undefined);
    const page = makePage();

    expect(page.isLoadingHistory()).toBe(true);
    await page.loadHistory();

    expect(M.getHistory).toHaveBeenCalledTimes(1);
    expect(page.isLoadingHistory()).toBe(false);
    expect(page.historyError()).toBeNull();
  });

  it('clears the loading flag and surfaces an error when the load fails', async () => {
    M.getHistory.mockRejectedValue(new Error('network down'));
    const page = makePage();

    await page.loadHistory();

    expect(page.isLoadingHistory()).toBe(false);
    expect(page.historyError()).toBe('We could not load your activity. Please try again.');
  });

  it('clears a previous error on a successful retry', async () => {
    M.getHistory.mockRejectedValueOnce(new Error('boom'));
    const page = makePage();

    await page.loadHistory();
    expect(page.historyError()).not.toBeNull();

    M.getHistory.mockResolvedValueOnce(undefined);
    await page.loadHistory();

    expect(page.historyError()).toBeNull();
    expect(page.isLoadingHistory()).toBe(false);
  });
});

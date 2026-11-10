/**
 * WALLET AUTH + PAYMENT STATUS CONSISTENCY + DRIVER RELIABILITY.
 *
 * PATCH 1 foundations: every protected Express payment/wallet call must send a
 * Bearer token; the two application-written payment states (requires_refund,
 * requires_review) must be permitted by the DB constraint; and the driver
 * reliability calc must read the cancellation reason from its authoritative
 * metadata location instead of a nonexistent column.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';

const read = (p: string) => readFileSync(pathResolve(process.cwd(), p), 'utf8');

const PAY = read('src/app/core/services/stripe/payment.service.ts');
const WALLET = read('src/app/core/services/wallet/wallet.service.ts');
const LOGISTICS = read('server/services/logistics.service.ts');
const MIGRATION = read('supabase/migrations/20261238000000_payment_status_consistency.sql');

describe('wallet/payment authenticated requests', () => {
  it('PaymentService sends a Bearer header on every protected call', () => {
    // getTransactions, confirmWalletTopup, refundPayment, createWalletTopupIntent
    expect(PAY).toContain('const headers = await this.getAuthHeaders();');
    expect(PAY).toContain("{ params: { userId }, headers }");
    expect(PAY).toContain('confirm-wallet-topup`, data, { headers }');
    expect(PAY).toContain('refund`, {');
    expect(PAY).toContain('Authorization: `Bearer ${token}`');
  });

  it('PaymentService createWalletTopupIntent passes headers', () => {
    const fn = PAY.slice(PAY.indexOf('async createWalletTopupIntent('), PAY.indexOf('async confirmCardPayment('));
    expect(fn).toContain('{ headers }');
  });

  it('WalletService has an auth helper and applies it to both API calls', () => {
    expect(WALLET).toContain('private async getAuthHeaders(): Promise<Record<string, string>>');
    expect(WALLET).toContain('Authorization: `Bearer ${token}`');
    // createWalletTopupIntent + payJobFromWallet
    const occurrences = WALLET.split('{ headers }').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('the helper throws (never silently proceeds) when there is no token', () => {
    expect(PAY).toContain("throw new Error('Please sign in again before starting payment.')");
    expect(WALLET).toContain("throw new Error('Please sign in again to continue.')");
  });

  it('the browser-supplied userId is still sent only as a body/query value, never as auth', () => {
    // Auth comes exclusively from the Authorization header; the userId is data,
    // and the server compares it against the authenticated identity (403 otherwise).
    expect(PAY).toContain('Authorization');
    expect(PAY).not.toMatch(/userId[^,]*Authorization|Authorization[^,]*userId/);
  });
});

describe('payment status consistency', () => {
  it('migration 380 extends the CHECK with the two canonical application states', () => {
    expect(MIGRATION).toContain("'requires_refund'");
    expect(MIGRATION).toContain("'requires_review'");
    expect(MIGRATION).toContain('DROP CONSTRAINT IF EXISTS jobs_payment_status_check');
    expect(MIGRATION).toContain('ADD CONSTRAINT jobs_payment_status_check CHECK');
  });

  it('migration 380 preserves every existing valid status', () => {
    for (const s of ['pending', 'authorized', 'wallet_funded', 'paid', 'cancelled', 'canceled', 'refunded', 'failed']) {
      expect(MIGRATION).toContain(`'${s}'`);
    }
  });

  it('the migration does not touch payment authority / Stripe / settlement', () => {
    const executable = MIGRATION.slice(MIGRATION.indexOf('ALTER TABLE'));
    expect(executable).not.toContain('capture');
    expect(executable).not.toContain('stripe');
    expect(executable).not.toContain('settlement');
    expect(executable).not.toContain('commission');
    expect(executable).not.toContain('CREATE OR REPLACE FUNCTION');
  });
});

describe('driver reliability cancellation reason', () => {
  const fn = () => LOGISTICS.slice(
    LOGISTICS.indexOf('static async updateDriverReliability('),
    LOGISTICS.indexOf('static async updateDriverReliability(') + 2000
  );

  it('reads the authoritative metadata location, not a nonexistent column', () => {
    expect(fn()).toContain("select('status, metadata')");
    expect(fn()).toContain('(j.metadata as any)?.cancellation_reason');
    expect(fn()).not.toContain("select('status, cancellation_reason')");
  });

  it('surfaces a query error instead of silently returning', () => {
    expect(fn()).toContain('const { data: jobs, error: jobsError }');
    expect(fn()).toContain('if (jobsError)');
    expect(fn()).toContain('console.error');
  });
});

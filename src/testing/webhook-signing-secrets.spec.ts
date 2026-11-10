/**
 * Webhook signing-secret separation.
 *
 * The subscriptions/Connect endpoint must verify against STRIPE_SUBSCRIPTIONS_WEBHOOK_SECRET,
 * never the payment STRIPE_WEBHOOK_SECRET, and fail closed when its own secret is absent.
 *
 * Uses the REAL stripe.webhooks.generateTestHeaderString / constructEvent so a signature
 * made with one secret is only accepted by the endpoint configured with that same secret.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const M = vi.hoisted(() => {
  const state = {
    driverAccountUpdate: null as any,
    loggedEvents: [] as Array<{ type: string; payload: any }>
  };
  const supabaseAdmin = {
    from: (table: string) => ({
      update: (payload: any) => ({
        eq: () => {
          if (table === 'driver_accounts') state.driverAccountUpdate = payload;
          return Promise.resolve({ data: null, error: null });
        }
      }),
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }),
      upsert: () => Promise.resolve({ error: null }),
      insert: () => Promise.resolve({ error: null })
    }),
    rpc: () => Promise.resolve({ error: null })
  };
  const EventService = {
    logEvent: vi.fn((type: string, payload: any) => {
      state.loggedEvents.push({ type, payload });
      return Promise.resolve();
    })
  };
  return { state, supabaseAdmin, EventService };
});

vi.mock('../../server/services/supabase.service', () => ({ supabaseAdmin: M.supabaseAdmin }));
vi.mock('../../server/services/event.service', () => ({ EventService: M.EventService }));

import { stripe, verifyWebhookSignature } from '../../server/services/stripe.service';
import { subscriptionWebhookHandler } from '../../server/routes/subscription.routes';

const PAY_SECRET = 'whsec_pay_test_secret_12345678';
const SUB_SECRET = 'whsec_sub_test_secret_12345678';

const EVENT = {
  id: 'evt_1',
  object: 'event',
  type: 'account.updated',
  data: { object: { id: 'acct_1', object: 'account', charges_enabled: true, payouts_enabled: true } }
};
const PAYLOAD = JSON.stringify(EVENT);

const header = (secret: string) => stripe.webhooks.generateTestHeaderString({ payload: PAYLOAD, secret });

function makeRes(): any {
  const res: any = { statusCode: 200 }; // Express default before an explicit .status()
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.send = (b: any) => { res.body = b; return res; };
  res.json = (b: any) => { res.body = b; return res; };
  return res;
}

async function run(signature: string) {
  const res = makeRes();
  await subscriptionWebhookHandler({ headers: { 'stripe-signature': signature }, body: PAYLOAD } as any, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  M.state.driverAccountUpdate = null;
  M.state.loggedEvents = [];
  process.env.STRIPE_WEBHOOK_SECRET = PAY_SECRET;
  process.env.STRIPE_SUBSCRIPTIONS_WEBHOOK_SECRET = SUB_SECRET;
});

describe('verifyWebhookSignature(secret)', () => {
  it('accepts a signature made with the SAME secret', () => {
    const event = verifyWebhookSignature(PAYLOAD, header(SUB_SECRET), SUB_SECRET);
    expect(event.type).toBe('account.updated');
  });

  it('rejects a signature made with a DIFFERENT secret', () => {
    expect(() => verifyWebhookSignature(PAYLOAD, header(PAY_SECRET), SUB_SECRET)).toThrow(/Webhook Error/i);
  });

  it('fails closed when the secret is missing', () => {
    expect(() => verifyWebhookSignature(PAYLOAD, header(SUB_SECRET), '')).toThrow(/not configured/i);
  });
});

describe('subscription webhook endpoint secret separation', () => {
  it('accepts an event signed with STRIPE_SUBSCRIPTIONS_WEBHOOK_SECRET and follows the account.updated readiness handler', async () => {
    const res = await run(header(SUB_SECRET));

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ received: true });
    // account.updated readiness-update path still runs.
    expect(M.state.driverAccountUpdate).toEqual({ charges_enabled: true, payouts_enabled: true });
    expect(M.state.loggedEvents.some(e => e.type === 'connect_account_updated')).toBe(true);
  });

  it('rejects the payment endpoint signature (the other destination)', async () => {
    const res = await run(header(PAY_SECRET));

    expect(res.statusCode).toBe(400);
    expect(String(res.body)).toMatch(/Webhook Error/i);
    expect(M.state.driverAccountUpdate).toBeNull();
  });

  it('fails closed when STRIPE_SUBSCRIPTIONS_WEBHOOK_SECRET is missing (no fallback to the payment secret)', async () => {
    delete process.env.STRIPE_SUBSCRIPTIONS_WEBHOOK_SECRET;
    // The payment secret is still present — but must NOT be used.
    process.env.STRIPE_WEBHOOK_SECRET = PAY_SECRET;

    const res = await run(header(PAY_SECRET));

    expect(res.statusCode).toBe(500);
    expect(String(res.body)).toMatch(/Missing webhook secret/i);
    expect(M.state.driverAccountUpdate).toBeNull();
  });
});

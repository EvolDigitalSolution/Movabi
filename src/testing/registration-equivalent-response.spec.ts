import { describe, expect, it, vi, beforeEach } from 'vitest';
import http from 'node:http';
import express from 'express';

const signUpMock = vi.fn();
// Test-only: neutralise the shared rate limiter (production keeps it).
vi.mock('express-rate-limit', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../server/services/supabase.service', () => ({
  supabaseAdmin: { auth: { getUser: vi.fn(async () => ({ data: { user: null } })), admin: { getUserById: vi.fn(async () => ({ data: { user: null } })) } }, from: vi.fn() },
  getSupabaseAuthRegistrationClient: () => ({ auth: { signUp: signUpMock } }),
}));
vi.mock('../../server/services/market-availability.service', () => ({
  MarketAvailabilityError: class MarketAvailabilityError extends Error { httpStatus = 422; code = 'MARKET_LOCATION_UNRESOLVED'; market = null; },
  MarketAvailabilityService: {
    normalizeCountry: (v: unknown) => (String(v || '').toUpperCase() || null),
    normalizeCity: (v: unknown) => (v ? String(v) : null),
    requireCapability: async () => ({ countryCode: 'GB', marketCity: null }),
  },
}));
vi.mock('../../server/services/registration-eligibility.service', () => ({
  RegistrationEligibilityService: { activate: vi.fn(async () => ({ activated: true })), getState: vi.fn() },
}));

import authRoutes from '../../server/routes/auth.routes';

function app() {
  const e = express();
  e.use(express.json());
  e.use(authRoutes);
  return e;
}
async function post(e: express.Express, body: unknown) {
  const server = http.createServer(e);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const resp = await fetch(`http://127.0.0.1:${port}/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  server.close();
  return { status: resp.status, body: data };
}

const BASE = { password: 'synthetic-password-123', countryCode: 'GB', data: { full_name: 'Test' } };

describe('registration public response is equivalent for existing and new emails', () => {
  beforeEach(() => signUpMock.mockReset());

  it('new email and existing (obfuscated) email return identical status + body', async () => {
    // 1. New identity: Supabase returns a real user with one identity.
    signUpMock.mockResolvedValueOnce({ data: { user: { id: 'new-user', identities: [{ id: 'i1' }] }, session: null }, error: null });
    const fresh = await post(app(), { email: 'new@example.test', ...BASE });
    // 2. Existing confirmed identity: Supabase returns an empty identities array.
    signUpMock.mockResolvedValueOnce({ data: { user: { id: 'existing-user', identities: [] }, session: null }, error: null });
    const existing = await post(app(), { email: 'existing@example.test', ...BASE });

    expect(fresh.status).toBe(202);
    expect(existing.status).toBe(202);
    expect(existing.body).toEqual(fresh.body);
    // The public body must not disclose existence, delivery, session or user.
    expect(JSON.stringify(fresh.body)).not.toMatch(/existing|confirmation|"session"|"user"/i);
    expect(fresh.body.message).toMatch(/If an account already exists/i);
  });

  it('duplicate-email error is normalised to the same neutral response', async () => {
    signUpMock.mockResolvedValueOnce({ data: { user: null }, error: { message: 'User already registered', status: 422 } });
    const dup = await post(app(), { email: 'existing2@example.test', ...BASE });
    signUpMock.mockResolvedValueOnce({ data: { user: { id: 'n2', identities: [{ id: 'i2' }] }, session: null }, error: null });
    const fresh = await post(app(), { email: 'new2@example.test', ...BASE });
    expect(dup.status).toBe(fresh.status);
    expect(dup.body).toEqual(fresh.body);
  });

  it('a genuine validation failure still surfaces its error (not masked)', async () => {
    signUpMock.mockResolvedValueOnce({ data: { user: null }, error: { message: 'Password should be at least 6 characters', status: 422 } });
    const r = await post(app(), { email: 'x@example.test', ...BASE });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/at least 6/i);
  });
});

describe('configuration 1 — email confirmation ENABLED', () => {
  beforeEach(() => signUpMock.mockReset());

  it('new and existing both return 202 neutral with no session, user or delivery claim', async () => {
    signUpMock.mockResolvedValueOnce({ data: { user: { id: 'n', identities: [{ id: 'i' }] }, session: null }, error: null });
    const fresh = await post(app(), { email: 'fresh@example.test', ...BASE });
    signUpMock.mockResolvedValueOnce({ data: { user: { id: 'e', identities: [] }, session: null }, error: null });
    const existing = await post(app(), { email: 'existing@example.test', ...BASE });

    expect(fresh.status).toBe(202);
    expect(existing.status).toBe(202);
    expect(existing.body).toEqual(fresh.body);
    expect(Object.keys(fresh.body).sort()).toEqual(['message', 'ok']);
    expect(JSON.stringify(fresh.body)).not.toMatch(/session|access_token|refresh_token|confirmation/i);
  });
});

describe('configuration 2 — email confirmation DISABLED', () => {
  beforeEach(() => signUpMock.mockReset());

  it('a genuinely new user receives the session so sign-up/onboarding continue', async () => {
    signUpMock.mockResolvedValueOnce({
      data: { user: { id: 'n2', identities: [{ id: 'i' }] }, session: { access_token: 'at', refresh_token: 'rt' } },
      error: null,
    });
    const r = await post(app(), { email: 'brand-new@example.test', ...BASE });
    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);
    expect(r.body.session).toEqual({ access_token: 'at', refresh_token: 'rt' });
  });

  it('an existing address is still normalised to the neutral response (no session)', async () => {
    signUpMock.mockResolvedValueOnce({ data: { user: null }, error: { message: 'User already registered', status: 422 } });
    const r = await post(app(), { email: 'already@example.test', ...BASE });
    expect(r.status).toBe(202);
    expect(r.body.session).toBeUndefined();
    expect(r.body.message).toMatch(/If an account already exists/i);
  });
});

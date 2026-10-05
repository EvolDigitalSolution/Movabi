import express, { Request, Response } from 'express';
import crypto from 'crypto';
import { rateLimit } from 'express-rate-limit';
import { EmailService } from '../services/email.service';
import { supabaseAdmin, getSupabaseAuthRegistrationClient } from '../services/supabase.service';
import { MarketAvailabilityError, MarketAvailabilityService } from '../services/market-availability.service';
import { RegistrationEligibilityService } from '../services/registration-eligibility.service';

const router = express.Router();

/** Resolve the authenticated user id from the Bearer session (never the body). */
const authUser = async (req: Request): Promise<string | null> => {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const { data } = await supabaseAdmin.auth.getUser(token);
  return data.user?.id || null;
};

const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 8,
  message: { error: 'Too many verification attempts. Please wait and try again.' },
});

const OTP_TTL_MS = 10 * 60 * 1000;
const VERIFIED_TTL_MS = 20 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const registrationLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 8, message: { error: 'Too many registration attempts. Please wait and try again.' } });

function normalizeEmail(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function hashCode(email: string, code: string): string {
  const secret = process.env.REGISTRATION_OTP_SECRET || process.env.JWT_SECRET || 'movabi-registration-otp';
  return crypto.createHmac('sha256', secret).update(`${email}:${code}`).digest('hex');
}

function createCode(): string {
  return crypto.randomInt(100000, 999999).toString();
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

router.post('/register', registrationLimiter, async (req: Request, res: Response) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const countryCode = MarketAvailabilityService.normalizeCountry(req.body?.countryCode);
    const marketCity = MarketAvailabilityService.normalizeCity(req.body?.marketCity);
    if (!isEmail(email) || password.length < 6) return res.status(400).json({ error: 'A valid email and password of at least 6 characters are required.' });
    if (!countryCode) return res.status(422).json({ error: 'Choose the country where you intend to use Movabi.', code: 'MARKET_LOCATION_UNRESOLVED' });
    const market = await MarketAvailabilityService.requireCapability({ countryCode, marketCity, capability: 'customer_registration', endpoint: '/api/auth/register' });
    const redirectTo = String(req.body?.emailRedirectTo || '');
    const safeRedirect = /^(https:\/\/|http:\/\/localhost(?::\d+)?\/|com\.movabi\.app:\/\/)/i.test(redirectTo) ? redirectTo : undefined;
    const metadata = { ...(req.body?.data || {}), registration_country_code: market.countryCode, registration_market_city: market.marketCity };
    const { data, error } = await getSupabaseAuthRegistrationClient().auth.signUp({ email, password, options: { data: metadata, ...(safeRedirect ? { emailRedirectTo: safeRedirect } : {}) } });
    if (error) return res.status(error.status || 400).json({ error: error.message });

    // Server-authoritative registration activation. Market eligibility was
    // validated ABOVE (before auth creation), so this identity is eligible. The
    // pending profile created by handle_new_user() is activated here and never
    // from client-settable auth metadata.
    let registration = null as Awaited<ReturnType<typeof RegistrationEligibilityService.getState>>;
    if (data.user?.id) {
      try {
        registration = await RegistrationEligibilityService.activate(data.user.id, {
          countryCode: market.countryCode,
          marketCity: market.marketCity
        });
      } catch (activationError) {
        // The identity and its pending profile still exist; the client can retry
        // through /api/markets/registration-eligibility. Never fail auth creation.
        console.error('[AuthRoutes] registration activation failed:', activationError);
        registration = await RegistrationEligibilityService.getState(data.user.id);
      }
    }

    return res.status(201).json({ user: data.user, session: data.session, market: { countryCode: market.countryCode, marketCity: market.marketCity }, registration });
  } catch (error) {
    if (error instanceof MarketAvailabilityError) return res.status(error.httpStatus).json({ error: error.message, code: error.code, market: error.market });
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Registration failed' });
  }
});

/**
 * Server-authoritative role selection (Phase 1).
 *
 * Registration must already be activated, and the role's OWN market capability
 * is enforced here, so a customer-registered market with driver registration
 * disabled cannot be bypassed by switching role. An account that already has a
 * role is returned unchanged (established users are never re-gated).
 */
router.post('/select-role', async (req: Request, res: Response) => {
  try {
    const userId = await authUser(req);
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const role = String(req.body?.role || '').toLowerCase();
    if (role !== 'customer' && role !== 'driver') {
      return res.status(400).json({ error: 'Choose customer or driver.', code: 'INVALID_ROLE' });
    }

    const registration = await RegistrationEligibilityService.getState(userId);
    if (!registration) return res.status(404).json({ error: 'Profile not found', code: 'PROFILE_NOT_FOUND' });
    if (!registration.activated) {
      return res.status(409).json({ error: 'Complete your registration market eligibility first.', code: 'REGISTRATION_PENDING' });
    }

    const { data: profile } = await supabaseAdmin.from('profiles').select('role').eq('id', userId).maybeSingle();
    const existingRole = String((profile as { role?: string } | null)?.role || '').toLowerCase();
    if (existingRole) {
      // Established role: never reassign or re-gate.
      return res.json({ role: existingRole, changed: false, registration });
    }

    const capability = role === 'driver' ? 'driver_registration' : 'customer_registration';
    await MarketAvailabilityService.requireCapability({
      countryCode: registration.registrationCountryCode,
      marketCity: registration.registrationMarketCity,
      capability,
      endpoint: '/api/auth/select-role'
    });

    const { error } = await supabaseAdmin.from('profiles').update({ role }).eq('id', userId);
    if (error) return res.status(400).json({ error: error.message });

    return res.json({ role, changed: true, registration });
  } catch (error) {
    if (error instanceof MarketAvailabilityError) {
      return res.status(error.httpStatus).json({ error: error.message, code: error.code, market: error.market });
    }
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Could not set your role.' });
  }
});

/**
 * Logout / account-switch hygiene: disable the CURRENT authenticated user's
 * device push registrations so they stop receiving pushes after signing out.
 *
 * The identity is derived ONLY from the Bearer session; a caller can never
 * disable another user's tokens. Uses existing `device_push_tokens` columns —
 * no migration.
 */
router.post('/push-logout', async (req: Request, res: Response) => {
  try {
    const userId = await authUser(req);
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    // CURRENT-DEVICE invalidation. The client sends ITS OWN device subscription
    // id (never a userId); the user is still derived only from the session, so a
    // caller can never disable another user's tokens or another device. A user
    // signed in on several devices keeps push on their other devices.
    const subscriptionId = typeof req.body?.subscriptionId === 'string'
      ? req.body.subscriptionId.trim()
      : '';

    if (!subscriptionId) {
      // No device identity to scope to (e.g. push never granted). Nothing to
      // invalidate; the client-side OneSignal unbind already stops delivery for
      // this device.
      return res.json({ success: true });
    }

    const { error } = await supabaseAdmin
      .from('device_push_tokens')
      .update({ enabled: false, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('subscription_id', subscriptionId);

    if (error) return res.status(500).json({ error: error.message });

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to disable push registrations' });
  }
});

router.post('/registration-otp/send', otpLimiter, async (req: Request, res: Response) => {
  const email = normalizeEmail(req.body?.email);

  if (!isEmail(email)) {
    return res.status(400).json({ error: 'Enter a valid email address before requesting a code.' });
  }

  const code = createCode();
  const delivered = await EmailService.sendRegistrationOtp(email, code);

  if (!delivered && process.env.NODE_ENV === 'production') {
    return res.status(503).json({ error: 'Could not send the verification email. Please try again.' });
  }

  const { error } = await supabaseAdmin
    .from('registration_otps')
    .upsert({
      email,
      code_hash: hashCode(email, code),
      expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(),
      attempts: 0,
      verified_until: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'email' });

  if (error) {
    console.error('[AuthRoutes] Failed to store registration OTP:', error);
    return res.status(500).json({ error: 'Could not prepare verification. Please try again.' });
  }

  res.json({
    ok: true,
    email,
    expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
    delivery: delivered ? 'email' : 'logged',
    devCode: delivered ? undefined : code,
  });
});

router.post('/registration-otp/verify', otpLimiter, async (req: Request, res: Response) => {
  const email = normalizeEmail(req.body?.email);
  const code = String(req.body?.code || '').replace(/\D/g, '');

  if (!isEmail(email) || code.length !== 6) {
    return res.status(400).json({ error: 'Enter the 6 digit code sent to your email.' });
  }

  const { data: record, error: fetchError } = await supabaseAdmin
    .from('registration_otps')
    .select('email, code_hash, expires_at, attempts')
    .eq('email', email)
    .maybeSingle();

  if (fetchError) {
    console.error('[AuthRoutes] Failed to load registration OTP:', fetchError);
    return res.status(500).json({ error: 'Could not verify this code. Please try again.' });
  }

  if (!record || new Date(record.expires_at).getTime() < Date.now()) {
    await supabaseAdmin.from('registration_otps').delete().eq('email', email);
    return res.status(400).json({ error: 'This verification code has expired. Please request a new code.' });
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    await supabaseAdmin.from('registration_otps').delete().eq('email', email);
    return res.status(429).json({ error: 'Too many incorrect codes. Please request a new code.' });
  }

  if (record.code_hash !== hashCode(email, code)) {
    await supabaseAdmin
      .from('registration_otps')
      .update({ attempts: Number(record.attempts || 0) + 1, updated_at: new Date().toISOString() })
      .eq('email', email);
    return res.status(400).json({ error: 'That code is not correct. Please check your email and try again.' });
  }

  const verifiedUntil = new Date(Date.now() + VERIFIED_TTL_MS).toISOString();
  await supabaseAdmin
    .from('registration_otps')
    .update({ verified_until: verifiedUntil, updated_at: new Date().toISOString() })
    .eq('email', email);

  res.json({ ok: true, email, verifiedUntil });
});

router.post('/registration-otp/status', async (req: Request, res: Response) => {
  const email = normalizeEmail(req.body?.email);
  const { data: record } = await supabaseAdmin
    .from('registration_otps')
    .select('verified_until')
    .eq('email', email)
    .maybeSingle();
  const verified = Boolean(record?.verified_until && new Date(record.verified_until).getTime() > Date.now());

  res.json({ ok: true, email, verified });
});

export default router;

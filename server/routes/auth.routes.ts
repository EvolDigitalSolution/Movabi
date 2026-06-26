import express, { Request, Response } from 'express';
import crypto from 'crypto';
import { rateLimit } from 'express-rate-limit';
import { EmailService } from '../services/email.service';
import { supabaseAdmin } from '../services/supabase.service';

const router = express.Router();

const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 8,
  message: { error: 'Too many verification attempts. Please wait and try again.' },
});

const OTP_TTL_MS = 10 * 60 * 1000;
const VERIFIED_TTL_MS = 20 * 60 * 1000;
const MAX_ATTEMPTS = 5;

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

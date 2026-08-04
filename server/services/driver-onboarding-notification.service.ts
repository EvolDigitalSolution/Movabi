import { EmailService } from './email.service';
import { supabaseAdmin } from './supabase.service';

export type DriverOnboardingEventType =
  | 'driver_registration_started'
  | 'driver_onboarding_submitted'
  | 'driver_vehicle_submitted'
  | 'driver_vehicle_updated'
  | 'driver_document_uploaded'
  | 'driver_document_replaced'
  | 'driver_document_resubmitted'
  | 'driver_stripe_connected'
  | 'driver_profile_updated_for_review';

export interface DriverOnboardingEventInput {
  eventKey: string;
  eventType: DriverOnboardingEventType;
  affectedItem: string;
  previousStatus?: string | null;
  newStatus?: string | null;
}

interface SafePayload {
  driverId: string;
  fullName: string;
  email: string;
  phone: string | null;
  country: string | null;
  city: string | null;
  eventType: DriverOnboardingEventType;
  affectedItem: string;
  previousStatus: string | null;
  newStatus: string | null;
  submittedAt: string;
  adminReviewUrl: string;
  correlationId: string;
}

export class DriverOnboardingNotificationService {
  private static readonly supported = new Set<DriverOnboardingEventType>([
    'driver_registration_started', 'driver_onboarding_submitted', 'driver_vehicle_submitted',
    'driver_vehicle_updated', 'driver_document_uploaded', 'driver_document_replaced',
    'driver_document_resubmitted', 'driver_stripe_connected', 'driver_profile_updated_for_review'
  ]);

  static isSupported(value: string): value is DriverOnboardingEventType {
    return this.supported.has(value as DriverOnboardingEventType);
  }

  static async enqueue(driverId: string, input: DriverOnboardingEventInput): Promise<{ id: string; duplicate: boolean }> {
    const { data: profile, error } = await supabaseAdmin.from('profiles')
      .select('full_name,first_name,last_name,email,phone,phone_number,country_code,market_city,city')
      .eq('id', driverId).single();
    if (error || !profile) throw error || new Error('Driver profile not found');
    const { data: auth } = await supabaseAdmin.auth.admin.getUserById(driverId);
    const submittedAt = new Date().toISOString();
    const baseUrl = String(process.env.ADMIN_APP_URL || 'https://movabi.apps.evolsolution.com').replace(/\/$/, '');
    const payload: SafePayload = {
      driverId,
      fullName: String(profile.full_name || [profile.first_name, profile.last_name].filter(Boolean).join(' ') || 'Driver'),
      email: String(profile.email || auth.user?.email || ''),
      phone: profile.phone || profile.phone_number || null,
      country: profile.country_code || null,
      city: profile.market_city || profile.city || null,
      eventType: input.eventType,
      affectedItem: String(input.affectedItem || 'onboarding'),
      previousStatus: input.previousStatus || null,
      newStatus: input.newStatus || null,
      submittedAt,
      adminReviewUrl: `${baseUrl}/admin/drivers/${encodeURIComponent(driverId)}/onboarding`,
      correlationId: input.eventKey
    };
    const { data, error: insertError } = await supabaseAdmin.from('driver_onboarding_notifications')
      .insert({ event_key: input.eventKey, driver_id: driverId, event_type: input.eventType, payload })
      .select('id').single();
    if (insertError?.code === '23505') {
      const { data: existing } = await supabaseAdmin.from('driver_onboarding_notifications')
        .select('id').eq('event_key', input.eventKey).single();
      return { id: existing?.id || '', duplicate: true };
    }
    if (insertError || !data) throw insertError || new Error('Could not enqueue onboarding notification');
    void this.deliver(data.id);
    return { id: data.id, duplicate: false };
  }

  static async deliver(id: string): Promise<void> {
    const { data: row } = await supabaseAdmin.from('driver_onboarding_notifications').select('*').eq('id', id).single();
    if (!row || row.status === 'sent' || Number(row.attempt_count) >= 3) return;
    const attempt = Number(row.attempt_count) + 1;
    await supabaseAdmin.from('driver_onboarding_notifications').update({ status: 'processing', attempt_count: attempt, updated_at: new Date().toISOString() }).eq('id', id).neq('status', 'sent');
    const payload = row.payload as SafePayload;
    const recipients = this.resolveRecipients(payload.country, payload.city);
    const market = payload.city || payload.country || 'Unknown market';
    const subject = `[Movabi] ${this.eventLabel(payload.eventType)} – ${market}`;
    const lines = [`Driver: ${payload.fullName}`, `Email: ${payload.email}`, `Phone: ${payload.phone || 'Not provided'}`, `Market: ${market}`,
      '', `Event: ${payload.eventType}`, `Affected item: ${payload.affectedItem}`, `Previous status: ${payload.previousStatus || 'Not recorded'}`,
      `Current status: ${payload.newStatus || 'Not recorded'}`, `Submitted: ${payload.submittedAt}`, '', `Review Driver Onboarding: ${payload.adminReviewUrl}`, `Correlation ID: ${payload.correlationId}`];
    const sent = await EmailService.sendDriverOnboardingAdminNotification(recipients, {
      subject, text: lines.join('\n'), html: `<div style="font-family:sans-serif"><h2>${this.escape(subject)}</h2>${lines.map(line => line ? `<p>${this.escape(line)}</p>` : '<hr>').join('')}</div>`
    });
    if (sent) {
      await supabaseAdmin.from('driver_onboarding_notifications').update({ status: 'sent', sent_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() }).eq('id', id);
      return;
    }
    const final = attempt >= 3;
    await supabaseAdmin.from('driver_onboarding_notifications').update({ status: final ? 'failed' : 'pending', last_error: 'Email provider did not confirm delivery', updated_at: new Date().toISOString() }).eq('id', id);
    if (!final) setTimeout(() => void this.deliver(id), attempt === 1 ? 30_000 : 300_000);
  }

  private static resolveRecipients(country: string | null, city: string | null): string[] {
    let marketMap: Record<string, string> = {};
    try { marketMap = JSON.parse(process.env.DRIVER_ONBOARDING_MARKET_EMAILS || '{}'); } catch { marketMap = {}; }
    const cityKey = `${String(country || '').toUpperCase()}:${String(city || '').trim().toLowerCase()}`;
    const countryList = process.env[`DRIVER_ONBOARDING_ADMIN_EMAILS_${String(country || '').toUpperCase()}`];
    return this.parseRecipients(marketMap[cityKey] || countryList || process.env.DRIVER_ONBOARDING_ADMIN_EMAILS || '');
  }

  private static parseRecipients(value: string): string[] {
    return Array.from(new Set(String(value).split(',').map(item => item.trim().toLowerCase()).filter(item => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item))));
  }
  private static eventLabel(event: DriverOnboardingEventType): string { return event.split('_').slice(1).map(word => word[0].toUpperCase() + word.slice(1)).join(' '); }
  private static escape(value: string): string { return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] || char)); }
}

import { supabaseAdmin } from './supabase.service';
import { MarketAvailabilityService } from './market-availability.service';

/**
 * Phase 1 — registration market eligibility authority.
 *
 * AUTHENTICATED (a Supabase identity exists) is deliberately NOT the same as
 * REGISTRATION-ELIGIBLE (the Movabi server validated a market capability).
 *
 * Only this service may set `profiles.registration_activated_at`. Raw Supabase
 * auth metadata (`registration_activated`, `country_code`, `role`, …) is
 * untrusted and can never activate an identity.
 *
 * Activation means exactly one thing: "this identity passed Movabi
 * registration-market eligibility". It does NOT mean the user is currently in
 * the registration country, online, onboarded, subscribed, or payment-enabled.
 */

export interface RegistrationState {
  /** True when the server has validated registration-market eligibility. */
  activated: boolean;
  /** True when the identity is authenticated but not yet registration-eligible. */
  pending: boolean;
  /** ISO2 country that passed capability validation (null while pending). */
  registrationCountryCode: string | null;
  /** Normalized market city that passed capability validation (null while pending). */
  registrationMarketCity: string | null;
  /** ISO timestamp of activation, or null while pending. */
  activatedAt: string | null;
}

const normalizeCity = (value: unknown): string | null => {
  const city = String(value ?? '').trim();
  return city ? city : null;
};

export class RegistrationEligibilityService {
  /**
   * Durable registration state. Reading never re-gates an established user on
   * their present physical location.
   */
  static async getState(userId: string): Promise<RegistrationState | null> {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('registration_activated_at,registration_country_code,registration_market_city')
      .eq('id', userId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    const row = data as Record<string, unknown>;
    const activatedAt = (row['registration_activated_at'] as string | null) || null;

    return {
      activated: !!activatedAt,
      pending: !activatedAt,
      registrationCountryCode: (row['registration_country_code'] as string | null) || null,
      registrationMarketCity: (row['registration_market_city'] as string | null) || null,
      activatedAt
    };
  }

  /**
   * Server-authoritative activation. Idempotent: an already-activated identity
   * keeps its original registration context and is returned unchanged.
   *
   * The caller MUST have validated the market capability first.
   */
  static async activate(
    userId: string,
    market: { countryCode?: unknown; marketCity?: unknown }
  ): Promise<RegistrationState> {
    const countryCode = MarketAvailabilityService.normalizeCountry(market.countryCode);
    if (!countryCode) {
      throw new Error('A validated country code is required to activate registration.');
    }
    const marketCity = normalizeCity(market.marketCity);

    const existing = await this.getState(userId);
    if (!existing) throw new Error('Profile not found');
    if (existing.activated) return existing;

    const { error } = await supabaseAdmin
      .from('profiles')
      .update({
        registration_activated_at: new Date().toISOString(),
        registration_country_code: countryCode,
        registration_market_city: marketCity,
        country_code: countryCode
      })
      .eq('id', userId);

    if (error) throw error;

    const state = await this.getState(userId);
    if (!state) throw new Error('Profile not found after activation');
    return state;
  }

  /**
   * Validate the intended registration market against `market_availability` and
   * activate. Idempotent; an already-activated identity is returned without any
   * further location-based gating.
   */
  static async ensureEligibility(
    userId: string,
    input: { countryCode?: unknown; marketCity?: unknown },
    capability: 'customer_registration' | 'driver_registration' = 'customer_registration'
  ): Promise<RegistrationState> {
    const existing = await this.getState(userId);
    if (!existing) throw new Error('Profile not found');
    if (existing.activated) return existing;

    const countryCode = MarketAvailabilityService.normalizeCountry(input.countryCode);
    const marketCity = normalizeCity(input.marketCity);

    const market = await MarketAvailabilityService.requireCapability({
      countryCode,
      marketCity,
      capability,
      endpoint: '/api/markets/registration-eligibility'
    });

    return this.activate(userId, { countryCode: market.countryCode, marketCity: market.marketCity });
  }
}

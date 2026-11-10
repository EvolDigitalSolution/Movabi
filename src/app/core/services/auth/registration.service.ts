import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ApiUrlService } from '../api-url.service';
import { SupabaseService } from '../supabase/supabase.service';
import { MarketAvailabilityFailure, marketFailureMessage } from '../../../shared/utils/market-failure';

/**
 * Registration-market eligibility (client).
 *
 * This is a thin client for the EXISTING server authority
 * (`/api/markets/registration-status` and `/api/markets/registration-eligibility`).
 * It never decides eligibility itself and never writes the profile.
 *
 * AUTHENTICATED is not the same as REGISTRATION-ACTIVATED: a Supabase session
 * (including one created by Google before Movabi is involved) only means an
 * identity exists. Only the server can activate registration.
 */
export interface RegistrationState {
  activated: boolean;
  pending: boolean;
  registrationCountryCode: string | null;
  registrationMarketCity: string | null;
  activatedAt: string | null;
}

@Injectable({ providedIn: 'root' })
export class RegistrationService {
  private http = inject(HttpClient);
  private api = inject(ApiUrlService);
  private supabase = inject(SupabaseService);

  readonly state = signal<RegistrationState | null>(null);
  /** True when the last status read could not be completed (offline/session). */
  readonly statusUnavailable = signal(false);

  private loadedForUserId: string | null = null;

  /** Drop cached state (sign-out / different identity). */
  clear(): void {
    this.state.set(null);
    this.loadedForUserId = null;
    this.statusUnavailable.set(false);
  }

  private async accessToken(): Promise<string | null> {
    const { data } = await this.supabase.auth.getSession();
    if (data.session?.access_token) return data.session.access_token;
    const { data: refreshed } = await this.supabase.auth.refreshSession();
    return refreshed.session?.access_token || null;
  }

  private async currentUserId(): Promise<string | null> {
    const { data } = await this.supabase.auth.getSession();
    return data.session?.user?.id || null;
  }

  /**
   * Load (and cache) registration status for the signed-in identity.
   *
   * Returns null when the state genuinely cannot be determined. Callers must
   * treat null as "unknown" and must NOT lock the user out on it: the server
   * remains the authority for every sensitive operation, and failing closed
   * here would strand a user on a transient network error.
   */
  async ensureLoaded(force = false): Promise<RegistrationState | null> {
    const userId = await this.currentUserId();
    if (!userId) {
      this.clear();
      return null;
    }

    if (!force && this.loadedForUserId === userId && this.state()) return this.state();

    try {
      const state = await this.fetchStatus();
      this.state.set(state);
      this.loadedForUserId = userId;
      this.statusUnavailable.set(false);
      return state;
    } catch (error) {
      console.warn('[RegistrationService] registration status unavailable', error);
      this.statusUnavailable.set(true);
      return null;
    }
  }

  async fetchStatus(): Promise<RegistrationState> {
    const token = await this.accessToken();
    if (!token) throw new Error('Your session expired. Please sign in again.');

    return await firstValueFrom(this.http.get<RegistrationState>(
      this.api.getApiUrl('/api/markets/registration-status'),
      { headers: new HttpHeaders({ Authorization: `Bearer ${token}` }) }
    ));
  }

  /**
   * Confirm the intended registration country/market. The server validates it
   * against market availability and only then activates the account.
   */
  async resolve(input: { countryCode?: string | null; marketCity?: string | null }): Promise<RegistrationState> {
    const token = await this.accessToken();
    if (!token) throw new Error('Your session expired. Please sign in again.');

    try {
      const state = await firstValueFrom(this.http.post<RegistrationState>(
        this.api.getApiUrl('/api/markets/registration-eligibility'),
        { countryCode: input.countryCode, marketCity: input.marketCity },
        { headers: new HttpHeaders({ Authorization: `Bearer ${token}` }) }
      ));
      this.state.set(state);
      this.loadedForUserId = await this.currentUserId();
      this.statusUnavailable.set(false);
      return state;
    } catch (error) {
      const body = error instanceof HttpErrorResponse ? (error.error as { code?: string; error?: string } | null) : null;
      if (body?.code) {
        throw new MarketAvailabilityFailure(body.code, marketFailureMessage(body.code, body.error || ''));
      }
      throw error;
    }
  }
}

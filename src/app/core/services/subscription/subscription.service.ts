import { Injectable, inject, signal } from '@angular/core';
import { SupabaseService } from '../supabase/supabase.service';
import { AuthService } from '../auth/auth.service';
import { ProfileService } from '../profile/profile.service';
import { Subscription } from '@shared/models/booking.model';
import { ApiUrlService } from '../api-url.service';

type JsonObject = Record<string, unknown>;

@Injectable({
  providedIn: 'root'
})
export class SubscriptionService {
  private supabase = inject(SupabaseService);
  private auth = inject(AuthService);
  private profileService = inject(ProfileService);
  private apiUrlService = inject(ApiUrlService);

  activeSubscription = signal<Subscription | null>(null);

  private readonly apiUrl = this.apiUrlService.getApiUrl('/api/subscriptions');

  async fetchActiveSubscription(): Promise<void> {
    const user = this.auth.currentUser();
    if (!user) {
      this.activeSubscription.set(null);
      return;
    }

    const { data, error } = await this.supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .order('current_period_end', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw error;
    }

    this.activeSubscription.set(data ?? null);
  }

  async createCheckoutSession(
    priceId: string,
    countryCode?: string,
    currencyCode?: string
  ): Promise<string> {
    const user = this.auth.currentUser();
    const profile = this.profileService.profile();

    if (!user || !profile) {
      throw new Error('Not authenticated or profile missing');
    }

    const data = await this.post<{ url: string }>(
      `${this.apiUrl}/create-checkout-session`,
      {
        userId: user.id,
        tenantId: profile.tenant_id,
        userEmail: user.email,
        priceId,
        countryCode,
        currencyCode
      }
    );

    if (!data.url) {
      throw new Error('Checkout session URL was not returned');
    }

    return data.url;
  }

  async getAvailablePlans(countryCode: string, currencyCode: string) {
    const { data, error } = await this.supabase
      .from('subscription_plans')
      .select('*')
      .eq('country_code', countryCode)
      .eq('currency_code', currencyCode)
      .eq('is_active', true);

    if (error) {
      throw error;
    }

    return data;
  }

  async openCustomerPortal(): Promise<void> {
    const profile = this.profileService.profile();

    if (!profile?.stripe_customer_id) {
      throw new Error('No Stripe customer found');
    }

    const data = await this.post<{ url: string }>(
      `${this.apiUrl}/create-portal-session`,
      {
        stripeCustomerId: profile.stripe_customer_id,
        returnUrl: `${window.location.origin}/driver/subscription`
      }
    );

    if (!data.url) {
      throw new Error('Customer portal URL was not returned');
    }

    window.location.href = data.url;
  }

  async refreshSubscriptionStatus(): Promise<void> {
    await this.fetchActiveSubscription();

    const user = this.auth.currentUser();
    if (user) {
      await this.profileService.fetchProfile(user.id);
    }
  }

  async handleSubscriptionSuccess(): Promise<void> {
    // Stripe webhook remains source of truth for DB changes.
    await this.refreshSubscriptionStatus();
  }

  async cancelSubscription(id: string): Promise<void> {
    const user = this.auth.currentUser();
    const sub = this.activeSubscription();

    if (!sub?.stripe_subscription_id) {
      const { error } = await this.supabase
        .from('driver_subscriptions')
        .update({ status: 'inactive' })
        .eq('id', id);

      if (error) {
        throw error;
      }
    } else {
      await this.post(
        `${this.apiUrl}/cancel`,
        {
          subscriptionId: id,
          stripeSubscriptionId: sub.stripe_subscription_id
        }
      );
    }

    if (user) {
      const { error } = await this.supabase
        .from('profiles')
        .update({ subscription_status: 'inactive' })
        .eq('id', user.id);

      if (error) {
        throw error;
      }
    }

    this.activeSubscription.set(null);
  }

  async getActiveSubscription(): Promise<Subscription | null> {
    const user = this.auth.currentUser();
    if (!user) {
      return null;
    }

    const { data, error } = await this.supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .order('current_period_end', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return data ?? null;
  }

  async checkSubscription(): Promise<Subscription | null> {
    const sub = await this.getActiveSubscription();
    this.activeSubscription.set(sub);
    return sub;
  }

  private async post<T = JsonObject>(
    url: string,
    body: JsonObject
  ): Promise<T> {
    const accessToken = await this.getAccessToken();

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
      },
      body: JSON.stringify(body)
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message =
        typeof data?.error === 'string'
          ? data.error
          : `Request failed with status ${response.status}`;
      throw new Error(message);
    }

    return data as T;
  }

  private async getAccessToken(): Promise<string | null> {
    const {
      data: { session }
    } = await this.supabase.auth.getSession();

    return session?.access_token ?? null;
  }
}
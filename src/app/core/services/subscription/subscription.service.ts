import { Injectable, inject, signal } from '@angular/core';
import { SupabaseService } from '../supabase/supabase.service';
import { AuthService } from '../auth/auth.service';
import { ProfileService } from '../profile/profile.service';
import { Subscription } from '@shared/models/booking.model';

@Injectable({
  providedIn: 'root'
})
export class SubscriptionService {
  private supabase = inject(SupabaseService);
  private auth = inject(AuthService);

  activeSubscription = signal<Subscription | null>(null);
  private apiUrl = 'http://localhost:3001/api/subscriptions';

  private profileService = inject(ProfileService);

  async fetchActiveSubscription() {
    const user = this.auth.currentUser();
    if (!user) return;

    const { data, error } = await this.supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .order('current_period_end', { ascending: false })
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    
    this.activeSubscription.set(data || null);
  }

  async createCheckoutSession(priceId: string) {
    const user = this.auth.currentUser();
    const profile = this.profileService.profile();
    
    if (!user || !profile) throw new Error('Not authenticated or profile missing');

    const response = await fetch(`${this.apiUrl}/create-checkout-session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: user.id,
        tenantId: profile.tenant_id,
        userEmail: user.email,
        priceId
      }),
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error);

    return data.url;
  }

  async openCustomerPortal() {
    const profile = this.profileService.profile();
    if (!profile?.stripe_customer_id) throw new Error('No Stripe customer found');

    const response = await fetch(`${this.apiUrl}/create-portal-session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        stripeCustomerId: profile.stripe_customer_id,
        returnUrl: `${window.location.origin}/driver/subscription`
      }),
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error);

    window.location.href = data.url;
  }

  async refreshSubscriptionStatus() {
    await this.fetchActiveSubscription();
    const user = this.auth.currentUser();
    if (user) {
      await this.profileService.fetchProfile(user.id);
    }
  }

  async handleSubscriptionSuccess(sessionId: string) {
    // Webhook handles the database update.
    // We just refresh the state here.
    await this.refreshSubscriptionStatus();
  }

  async cancelSubscription(id: string) {
    const user = this.auth.currentUser();
    const sub = this.activeSubscription();
    
    if (!sub?.stripe_subscription_id) {
      // Fallback for mock/manual subscriptions
      const { error } = await this.supabase
        .from('driver_subscriptions')
        .update({ status: 'inactive' })
        .eq('id', id);

      if (error) throw error;
    } else {
      // Call Node backend to cancel Stripe subscription
      const response = await fetch(`${this.apiUrl}/cancel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          subscriptionId: id,
          stripeSubscriptionId: sub.stripe_subscription_id
        }),
      });

      const data = await response.json();
      if (data.error) throw new Error(data.error);
    }

    if (user) {
      await this.supabase
        .from('profiles')
        .update({ subscription_status: 'inactive' })
        .eq('id', user.id);
    }

    this.activeSubscription.set(null);
  }

  async getActiveSubscription(): Promise<Subscription | null> {
    const user = this.auth.currentUser();
    if (!user) return null;

    const { data, error } = await this.supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', user.id)
      .eq('status', 'active')
      .order('current_period_end', { ascending: false })
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data || null;
  }

  async checkSubscription(): Promise<Subscription | null> {
    const sub = await this.getActiveSubscription();
    this.activeSubscription.set(sub);
    return sub;
  }
}

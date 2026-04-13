import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { SupabaseService } from '../supabase/supabase.service';
import { Wallet, ErrandFunding } from '@shared/models/booking.model';
import { AuthService } from '../auth/auth.service';
import { ApiUrlService } from '../api-url.service';

export interface CreateWalletTopupIntentRequest {
  amount: number;
  currencyCode?: string;
}

export interface CreateWalletTopupIntentResponse {
  clientSecret: string;
  paymentIntentId: string;
}

@Injectable({
  providedIn: 'root'
})
export class WalletService {
  private supabase = inject(SupabaseService);
  private auth = inject(AuthService);
  private http = inject(HttpClient);
  private apiUrlService = inject(ApiUrlService);

  private readonly paymentApiUrl = this.apiUrlService.getApiUrl('/api/payment');

  wallet = signal<Wallet | null>(null);

  async fetchWallet(): Promise<Wallet | null> {
    const user = this.auth.currentUser();
    if (!user) {
      this.wallet.set(null);
      return null;
    }

    const { data, error } = await this.supabase
      .from('wallets')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle();

    if (error) {
      console.error('Error fetching wallet:', error);
      return null;
    }

    this.wallet.set(data ?? null);
    return data ?? null;
  }

  async reserveErrandFunds(jobId: string, itemBudget: number, serviceEstimate: number) {
    const user = this.auth.currentUser();
    if (!user) {
      throw new Error('Not authenticated');
    }

    const { data, error } = await this.supabase.rpc('reserve_errand_funds', {
      p_job_id: jobId,
      p_customer_id: user.id,
      p_item_budget: itemBudget,
      p_service_estimate: serviceEstimate
    });

    if (error) {
      console.error('Error reserving funds:', error);
      throw new Error(`Failed to reserve funds: ${error.message}`);
    }

    await this.fetchWallet();
    return data;
  }

  async settleErrandFunds(jobId: string): Promise<void> {
    const { error } = await this.supabase.rpc('settle_errand_funds', {
      p_job_id: jobId
    });

    if (error) {
      console.error('Error settling funds:', error);
      throw new Error(`Failed to settle funds: ${error.message}`);
    }

    await this.fetchWallet();
  }

  async requestErrandOverBudget(jobId: string, newRequiredItemBudget: number, reason: string): Promise<void> {
    const { error } = await this.supabase.rpc('request_errand_over_budget', {
      p_job_id: jobId,
      p_amount: newRequiredItemBudget,
      p_reason: reason
    });

    if (error) {
      console.error('Error requesting over-budget:', error);
      throw new Error(`Failed to request over-budget: ${error.message}`);
    }
  }

  async approveErrandOverBudget(jobId: string): Promise<void> {
    const { error } = await this.supabase.rpc('approve_errand_over_budget', {
      p_job_id: jobId
    });

    if (error) {
      console.error('Error approving over-budget:', error);
      throw new Error(`Failed to approve over-budget: ${error.message}`);
    }

    await this.fetchWallet();
  }

  async rejectErrandOverBudget(jobId: string): Promise<void> {
    const { error } = await this.supabase.rpc('reject_errand_over_budget', {
      p_job_id: jobId
    });

    if (error) {
      console.error('Error rejecting over-budget:', error);
      throw new Error(`Failed to reject over-budget: ${error.message}`);
    }
  }

  async getErrandFunding(jobId: string): Promise<ErrandFunding | null> {
    const { data, error } = await this.supabase
      .from('errand_funding')
      .select('*')
      .eq('job_id', jobId)
      .maybeSingle();

    if (error) {
      console.error('Error fetching errand funding:', error);
      return null;
    }

    return data ?? null;
  }

  async createWalletTopupIntent(
    amount: number,
    currencyCode?: string
  ): Promise<CreateWalletTopupIntentResponse> {
    const user = this.auth.currentUser();
    if (!user) {
      throw new Error('Not authenticated');
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Top-up amount must be greater than zero');
    }

    return firstValueFrom(
      this.http.post<CreateWalletTopupIntentResponse>(
        `${this.paymentApiUrl}/create-wallet-topup-intent`,
        {
          userId: user.id,
          amount,
          currency: currencyCode || this.auth.profileService.profile()?.currency_code || 'GBP',
          tenantId: this.auth.tenantId()
        }
      )
    );
  }

  async refreshWalletAfterTopup(): Promise<Wallet | null> {
    return this.fetchWallet();
  }

  /**
   * Intentionally removed direct wallet mutation.
   * Wallet balance must only be credited after verified Stripe payment success
   * via backend/webhook -> trusted DB function.
   */
  async topUp(): Promise<never> {
    throw new Error(
      'Direct wallet top-up is disabled. Use Stripe payment flow and webhook-backed wallet credit.'
    );
  }
}
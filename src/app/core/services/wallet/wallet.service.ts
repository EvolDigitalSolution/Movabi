import {recordedWalletAmount} from '@shared/utils/wallet-recorded-money';
import { approvedErrandBudget } from '@shared/utils/errand-budget';
import { Injectable, inject, signal, computed, effect } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, timeout } from 'rxjs';
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

export interface WalletJobPaymentResponse {
  success: boolean;
  paymentMethod: 'wallet';
  amount: number;
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
  private readonly walletApiUrl = this.apiUrlService.getApiUrl('/api/wallet');

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const { data } = await this.supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      throw new Error('Please sign in again to continue.');
    }
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    };
  }

  private readonly storedWallet=signal<Wallet|null>(null);
  readonly wallet=computed(()=>{const user=this.auth.currentUser();const wallet=this.storedWallet();return user&&wallet?.user_id===user.id?wallet:null;});
  readonly walletLoading=signal(false);
  readonly walletError=signal('');
  private walletOwner:string|null=null;
  private walletEpoch=0;
  private walletPending:Promise<Wallet|null>|null=null;

  constructor(){effect(()=>{this.syncWalletOwner();});}

  private syncWalletOwner():string|null {
    const owner=this.auth.currentUser()?.id||null;
    if(owner!==this.walletOwner){this.walletOwner=owner;this.walletEpoch++;this.walletPending=null;this.storedWallet.set(null);this.walletLoading.set(false);this.walletError.set('');}
    return owner;
  }

  walletBalanceText(compact=false):string {
    if(!this.auth.currentUser())return compact?'Wallet':'Sign in to view wallet';
    if(this.walletLoading())return compact?'Checking…':'Checking wallet…';
    if(this.walletError())return compact?'Unavailable':'Wallet unavailable';
    const wallet=this.wallet();
    return wallet?recordedWalletAmount(wallet.available_balance,wallet.currency_code):(compact?'Wallet':'Not set up');
  }

  fetchWallet():Promise<Wallet|null> {
    const owner=this.syncWalletOwner();
    if(!owner)return Promise.resolve(null);
    if(this.walletPending)return this.walletPending;
    const epoch=this.walletEpoch;
    const current=()=>this.walletEpoch===epoch&&this.auth.currentUser()?.id===owner;
    this.storedWallet.set(null);this.walletError.set('');this.walletLoading.set(true);
    const request:Promise<Wallet|null>=Promise.resolve().then(async()=>{
      if(!current())return null;
      const {data:record,error}=await this.supabase.from('wallets').select('*').eq('user_id',owner).maybeSingle();
      if(!current())return null;
      if(error)throw Error('Wallet read unavailable');
      const data=record??await this.setupMissingWallet(owner);
      if(!current())return null;
      if(data&&(data.user_id!==owner||/unavailable$/.test(recordedWalletAmount(data.available_balance,data.currency_code))
        ||/unavailable$/.test(recordedWalletAmount(data.reserved_balance,data.currency_code))))throw Error('Wallet record invalid');
      this.storedWallet.set(data??null);return data??null;
    }).catch(()=>{if(current()){this.storedWallet.set(null);this.walletError.set('Wallet could not be verified. Please refresh.');}return null;})
      .finally(()=>{if(this.walletPending===request){this.walletPending=null;if(current())this.walletLoading.set(false);}});
    this.walletPending=request;return request;
  }


  private async setupMissingWallet(owner:string):Promise<Wallet|null> {
    const {data,error}=await this.supabase.auth.getSession();const session=data.session;
    if(error||!session?.access_token||session.user.id!==owner||this.auth.currentUser()?.id!==owner)throw Error('Account changed');
    try{
      const result=await firstValueFrom(this.http.post<{wallet:Wallet}>(`${this.walletApiUrl}/setup`,{},
        {headers:{Authorization:'Bearer '+session.access_token}}).pipe(timeout(15000)));
      if(this.auth.currentUser()?.id!==owner)return null;
      if(!result?.wallet||result.wallet.user_id!==owner)throw Error('Wallet setup owner mismatch');
      return result.wallet;
    }catch(error:unknown){
      const code=(error as {error?:{code?:string}})?.error?.code;
      if(code&&['CUSTOMER_WALLET_SETUP_DISABLED','CUSTOMER_WALLET_NOT_READY','CUSTOMER_WALLET_MARKET_UNAVAILABLE'].includes(code))return null;
      throw error;
    }
  }

  async reserveErrandFunds(jobId: string, itemBudget: number, serviceEstimate: number) {
    const user = this.auth.currentUser();
    if (!user) {
      throw new Error('Not authenticated');
    }

    // The server derives the fare/budget and reserves + activates atomically.
    return this.payJobFromWallet(jobId, itemBudget + serviceEstimate);
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

  async requestErrandOverBudget(jobId: string, additionalAmount: number, reason: string): Promise<void> {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 15000);
    try {
      const { data: funding, error: fundingError } = await this.supabase.from('errand_funding')
        .select('*').eq('job_id', jobId).abortSignal(controller.signal).maybeSingle();
      if (fundingError) throw fundingError;
      if (!funding || !Number.isFinite(additionalAmount) || additionalAmount <= 0) {
        throw new Error('Enter a valid additional shopping amount.');
      }
      const {data:details,error:detailsError}=await this.supabase.from('errand_details')
        .select('estimated_budget').eq('job_id',jobId).abortSignal(controller.signal).maybeSingle();
      if(detailsError) throw detailsError;
      const total = Number((approvedErrandBudget(funding,details?.estimated_budget) + additionalAmount).toFixed(2));
      const { error } = await this.supabase.rpc('request_errand_over_budget', {
        p_job_id: jobId, p_amount: total, p_reason: reason
      }).abortSignal(controller.signal);
      if (error) throw error;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Request timed out. Check whether the budget request was received before trying again.');
      throw error;
    } finally { clearTimeout(deadline); }
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

    const headers = await this.getAuthHeaders();
    return firstValueFrom(
      this.http.post<CreateWalletTopupIntentResponse>(
        `${this.paymentApiUrl}/create-wallet-topup-intent`,
        {
          userId: user.id,
          amount,
          currency: currencyCode || this.auth.profileService.profile()?.currency_code || 'GBP',
          tenantId: this.auth.tenantId()
        },
        { headers }
      )
    );
  }

  async payJobFromWallet(
    jobId: string,
    amount: number,
    currencyCode?: string
  ): Promise<WalletJobPaymentResponse> {
    const user = this.auth.currentUser();
    if (!user) {
      throw new Error('Not authenticated');
    }

    if (!jobId?.trim()) {
      throw new Error('jobId is required');
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Wallet payment amount must be greater than zero');
    }

    try {
      const headers = await this.getAuthHeaders();
      const response = await firstValueFrom(
        this.http.post<WalletJobPaymentResponse>(
          `${this.walletApiUrl}/pay-job`,
          {
            userId: user.id,
            jobId,
            amount,
            currency: currencyCode || this.auth.profileService.profile()?.currency_code || 'GBP',
            tenantId: this.auth.tenantId()
          },
          { headers }
        )
      );

      await this.fetchWallet();
      return response;
    } catch (error: any) {
      console.error('[WalletService] payJobFromWallet failed:', error);
      const message =
        error?.error?.error ||
        error?.error?.message ||
        error?.message ||
        'Wallet payment failed';
      throw new Error(message);
    }
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

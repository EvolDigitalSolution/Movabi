import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ApiUrlService } from '../api-url.service';

@Injectable({
  providedIn: 'root'
})
export class ConnectService {
  private http = inject(HttpClient);
  private apiUrlService = inject(ApiUrlService);
  private apiUrl = this.apiUrlService.getApiUrl('/api/connect');

  async createAccount(userId: string, email: string, tenantId: string) {
    return firstValueFrom(this.http.post<{ stripe_account_id: string }>(`${this.apiUrl}/create-account`, {
      userId,
      email,
      tenantId
    }));
  }

  async getOnboardingLink(accountId: string, returnUrl: string, refreshUrl: string) {
    return firstValueFrom(this.http.post<{ url: string }>(`${this.apiUrl}/onboarding-link`, {
      accountId,
      returnUrl,
      refreshUrl
    }));
  }

  async getDashboardLink(accountId: string) {
    return firstValueFrom(this.http.post<{ url: string }>(`${this.apiUrl}/dashboard-link`, {
      accountId
    }));
  }

  async getAccountStatus(accountId: string) {
    return firstValueFrom(this.http.get<{ 
      onboarding_complete: boolean, 
      payouts_enabled: boolean, 
      charges_enabled: boolean,
      status: 'not_started' | 'pending' | 'restricted' | 'enabled'
    }>(`${this.apiUrl}/account-status/${accountId}`));
  }
}

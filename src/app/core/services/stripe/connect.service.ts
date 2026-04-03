import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../../environments/environment';

@Injectable({
  providedIn: 'root'
})
export class ConnectService {
  private http = inject(HttpClient);
  private apiUrl = '/api/connect';

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
}

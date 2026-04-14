import { Injectable } from '@angular/core';
import { environment } from '@env/environment';

@Injectable({
  providedIn: 'root'
})
export class ApiUrlService {
  private readonly apiBaseUrl: string;

  constructor() {
    this.apiBaseUrl = this.resolveApiBaseUrl();
    console.log('[ApiUrlService] environment.apiUrl =', environment.apiUrl);
    console.log('[ApiUrlService] resolved apiBaseUrl =', this.apiBaseUrl);
  }

  private resolveApiBaseUrl(): string {
    const configured = environment.apiUrl?.trim() || '';

    if (!configured) {
      throw new Error('ApiUrlService: environment.apiUrl is missing');
    }

    try {
      return new URL(configured).toString().replace(/\/$/, '');
    } catch {
      throw new Error(`ApiUrlService: invalid environment.apiUrl: ${configured}`);
    }
  }

  getApiUrl(path: string): string {
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    return `${this.apiBaseUrl}${cleanPath}`;
  }

  getBaseUrl(): string {
    return this.apiBaseUrl;
  }
}
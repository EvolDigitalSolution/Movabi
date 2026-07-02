import { Injectable, computed, inject, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { environment } from '@env/environment';
import { ApiUrlService } from './api-url.service';

export type AppUpdateSeverity = 'optional' | 'recommended' | 'required' | 'critical';
export type AppUpdatePlatform = 'web' | 'android' | 'ios';

export interface AppUpdateState {
  checked: boolean;
  loading: boolean;
  platform: AppUpdatePlatform;
  localVersion: string;
  currentVersion: string;
  minimumVersion: string;
  updateRequired: boolean;
  severity: AppUpdateSeverity;
  title: string;
  message: string;
  releaseNotes: string;
  updateUrl: string;
  webReloadRequired: boolean;
  canDismiss: boolean;
  dismissed: boolean;
}

const DEFAULT_STATE: AppUpdateState = {
  checked: false,
  loading: false,
  platform: 'web',
  localVersion: '1.0.0',
  currentVersion: '1.0.0',
  minimumVersion: '1.0.0',
  updateRequired: false,
  severity: 'optional',
  title: 'Movabi update available',
  message: 'A new version of Movabi is available.',
  releaseNotes: '',
  updateUrl: '',
  webReloadRequired: false,
  canDismiss: true,
  dismissed: false
};

@Injectable({ providedIn: 'root' })
export class AppVersionService {
  private apiUrl = inject(ApiUrlService);
  private pollId: ReturnType<typeof setInterval> | null = null;
  private readonly dismissKey = 'movabi_update_notice_dismissed_version';

  readonly updateState = signal<AppUpdateState>({
    ...DEFAULT_STATE,
    platform: this.getPlatform(),
    localVersion: this.getLocalVersion()
  });

  readonly shouldShowUpdate = computed(() => {
    const state = this.updateState();
    if (!state.checked) return false;
    if (state.updateRequired || state.severity === 'required' || state.severity === 'critical') return true;
    if (state.severity === 'recommended' && !state.dismissed) return true;
    return state.webReloadRequired && this.isServerVersionNewer(state.localVersion, state.currentVersion) && !state.dismissed;
  });

  init(role?: string | null): void {
    void this.checkNow(role || this.detectRoleFromPath());

    if (!this.pollId) {
      this.pollId = setInterval(() => {
        void this.checkNow(this.detectRoleFromPath());
      }, 10 * 60 * 1000);
    }

    CapacitorApp.addListener('resume', () => {
      void this.checkNow(this.detectRoleFromPath());
    }).catch(() => {
      // Web/dev may not support native resume listeners.
    });
  }

  async checkNow(role?: string | null): Promise<void> {
    const platform = this.getPlatform();
    const localVersion = this.getLocalVersion();

    this.updateState.update(state => ({ ...state, loading: true, platform, localVersion }));

    try {
      const params = new URLSearchParams({
        platform,
        version: localVersion,
        role: role || this.detectRoleFromPath()
      });
      const response = await fetch(this.apiUrl.getApiUrl(`/api/app/version?${params.toString()}`));

      if (!response.ok) {
        throw new Error(`Version check failed: ${response.status}`);
      }

      const data = await response.json();
      const currentVersion = String(data.currentVersion || localVersion);
      const dismissedVersion = localStorage.getItem(this.dismissKey);

      this.updateState.set({
        checked: true,
        loading: false,
        platform,
        localVersion,
        currentVersion,
        minimumVersion: String(data.minimumVersion || localVersion),
        updateRequired: Boolean(data.updateRequired),
        severity: this.normaliseSeverity(data.severity),
        title: String(data.title || DEFAULT_STATE.title),
        message: String(data.message || DEFAULT_STATE.message),
        releaseNotes: String(data.releaseNotes || ''),
        updateUrl: String(data.updateUrl || ''),
        webReloadRequired: Boolean(data.webReloadRequired),
        canDismiss: data.canDismiss !== false,
        dismissed: dismissedVersion === currentVersion
      });
    } catch (error) {
      console.warn('[AppVersion] check skipped safely', error);
      this.updateState.update(state => ({ ...state, checked: true, loading: false }));
    }
  }

  dismiss(): void {
    const state = this.updateState();
    if (!state.canDismiss && (state.updateRequired || state.severity === 'required' || state.severity === 'critical')) return;
    localStorage.setItem(this.dismissKey, state.currentVersion);
    this.updateState.update(previous => ({ ...previous, dismissed: true }));
  }

  async performUpdateAction(): Promise<void> {
    const state = this.updateState();

    if (state.platform === 'web') {
      await this.clearWebCaches();
      window.location.reload();
      return;
    }

    if (state.updateUrl) {
      window.open(state.updateUrl, '_system');
      return;
    }

    console.warn('[AppVersion] native update URL missing');
  }

  private getPlatform(): AppUpdatePlatform {
    const platform = Capacitor.getPlatform();
    return platform === 'android' || platform === 'ios' ? platform : 'web';
  }

  private getLocalVersion(): string {
    return String((environment as any).appVersion || '1.0.0').trim() || '1.0.0';
  }

  private detectRoleFromPath(): string {
    const path = window.location.pathname;
    if (path.startsWith('/admin')) return 'admin';
    if (path.startsWith('/driver')) return 'driver';
    return 'customer';
  }

  private normaliseSeverity(value: unknown): AppUpdateSeverity {
    const severity = String(value || '').toLowerCase();
    return ['optional', 'recommended', 'required', 'critical'].includes(severity)
      ? severity as AppUpdateSeverity
      : 'optional';
  }

  private isServerVersionNewer(localVersion: string, serverVersion: string): boolean {
    const parse = (version: string) => String(version || '0')
      .split(/[.-]/)
      .slice(0, 4)
      .map(part => Number(part.replace(/\D/g, '') || 0));
    const local = parse(localVersion);
    const server = parse(serverVersion);
    const length = Math.max(local.length, server.length, 3);

    for (let index = 0; index < length; index += 1) {
      const diff = (server[index] || 0) - (local[index] || 0);
      if (diff !== 0) return diff > 0;
    }

    return false;
  }

  private async clearWebCaches(): Promise<void> {
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(key => caches.delete(key)));
      }

      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map(registration => registration.update().catch(() => undefined)));
      }
    } catch (error) {
      console.warn('[AppVersion] cache refresh skipped safely', error);
    }
  }
}

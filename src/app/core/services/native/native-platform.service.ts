import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Device } from '@capacitor/device';
import { Keyboard, KeyboardResize, KeyboardStyle } from '@capacitor/keyboard';
import { LocalNotifications } from '@capacitor/local-notifications';
import { PushNotifications, Token } from '@capacitor/push-notifications';
import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar, Style } from '@capacitor/status-bar';
import { ReplaySubject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class NativePlatformService {
  private router = inject(Router);
  private initialized = false;

  readonly isNative = Capacitor.isNativePlatform();
  readonly platform = Capacitor.getPlatform();
  readonly appIsActive = signal(true);
  readonly pushToken$ = new ReplaySubject<string>(1);

  async initialize(): Promise<void> {
    if (!this.isNative || this.initialized) return;
    this.initialized = true;

    await Promise.allSettled([
      StatusBar.setOverlaysWebView({ overlay: false }),
      StatusBar.setStyle({ style: Style.Dark }),
      Keyboard.setResizeMode({ mode: KeyboardResize.Body }),
      Keyboard.setStyle({ style: KeyboardStyle.Light }),
      Device.getInfo()
    ]);

    if (this.platform === 'android') {
      await StatusBar.setBackgroundColor({ color: '#F8FAFC' }).catch(() => undefined);
    }

    await this.configurePushListeners();
    await this.registerPushWhenAlreadyGranted();

    await App.addListener('appStateChange', ({ isActive }) => this.appIsActive.set(isActive));
    await App.addListener('appUrlOpen', ({ url }) => {
      void Browser.close().catch(() => undefined);
      const parsed = this.safeUrl(url);
      if (!parsed) return;
      const route = `${parsed.pathname}${parsed.search}${parsed.hash}`;
      if (route.startsWith('/')) void this.router.navigateByUrl(route);
    });

    requestAnimationFrame(() => {
      void SplashScreen.hide({ fadeOutDuration: 220 });
    });
  }

  async requestNotificationPermission(): Promise<boolean> {
    if (!this.isNative) return false;

    const pushPermission = await PushNotifications.requestPermissions();
    const localPermission = await LocalNotifications.requestPermissions();
    const granted = pushPermission.receive === 'granted';

    if (granted) await PushNotifications.register();
    return granted && localPermission.display === 'granted';
  }

  async showForegroundNotification(title: string, body: string, extra?: Record<string, unknown>): Promise<void> {
    if (!this.isNative || !this.appIsActive()) return;
    const permission = await LocalNotifications.checkPermissions();
    if (permission.display !== 'granted') return;

    await LocalNotifications.schedule({
      notifications: [{
        id: Math.floor(Date.now() % 2147483647),
        title,
        body,
        extra,
        schedule: { at: new Date(Date.now() + 150) },
        smallIcon: 'ic_stat_movabi',
        iconColor: '#F59E0B'
      }]
    });
  }

  private async configurePushListeners(): Promise<void> {
    await PushNotifications.addListener('registration', (token: Token) => this.pushToken$.next(token.value));
    await PushNotifications.addListener('registrationError', (error) => {
      console.warn('[NativePlatform] Push registration failed', error);
    });
    await PushNotifications.addListener('pushNotificationActionPerformed', ({ notification }) => {
      const data = notification.data || {};
      const route = String(data['route'] || data['url'] || '').trim();
      if (route.startsWith('/')) void this.router.navigateByUrl(route);
    });
  }

  private async registerPushWhenAlreadyGranted(): Promise<void> {
    const permission = await PushNotifications.checkPermissions();
    if (permission.receive === 'granted') await PushNotifications.register();
  }

  private safeUrl(value: string): URL | null {
    try {
      return new URL(value);
    } catch {
      return null;
    }
  }
}

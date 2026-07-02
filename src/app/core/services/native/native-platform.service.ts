import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Device } from '@capacitor/device';
import { Haptics, NotificationType } from '@capacitor/haptics';
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
      StatusBar.setStyle({ style: Style.Light }),
      Keyboard.setResizeMode({ mode: KeyboardResize.Body }),
      Keyboard.setStyle({ style: KeyboardStyle.Light }),
      Keyboard.setScroll({ isDisabled: false }),
      Device.getInfo()
    ]);

    if (this.platform === 'android') {
      await StatusBar.setBackgroundColor({ color: '#F8FAFC' }).catch(() => undefined);
    }

    await this.configurePushListeners();
    await this.configureKeyboardListeners();
    await this.registerPushWhenAlreadyGranted();

    await App.addListener('appStateChange', ({ isActive }) => this.appIsActive.set(isActive));
    await App.addListener('appUrlOpen', ({ url }) => {
      void Browser.close().catch(() => undefined);
      const parsed = this.safeUrl(url);
      if (!parsed) return;
      const route = this.routeFromAppUrl(parsed);
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
    if (!this.isNative) return;

    await Haptics.notification({ type: NotificationType.Success }).catch(() => undefined);

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

  private async configureKeyboardListeners(): Promise<void> {
    const show = (height?: number) => {
      document.body.classList.add('native-keyboard-open');
      if (height) document.documentElement.style.setProperty('--native-keyboard-height', `${height}px`);
      window.setTimeout(() => this.scrollFocusedInputIntoView(), 80);
    };
    const hide = () => {
      document.body.classList.remove('native-keyboard-open');
      document.documentElement.style.removeProperty('--native-keyboard-height');
    };

    await Keyboard.addListener('keyboardWillShow', ({ keyboardHeight }) => show(keyboardHeight));
    await Keyboard.addListener('keyboardDidShow', ({ keyboardHeight }) => show(keyboardHeight));
    await Keyboard.addListener('keyboardWillHide', hide);
    await Keyboard.addListener('keyboardDidHide', hide);
  }

  private scrollFocusedInputIntoView(): void {
    const active = document.activeElement as HTMLElement | null;
    if (!active) return;

    const tag = active.tagName.toLowerCase();
    const isInput = tag === 'input' || tag === 'textarea' || tag === 'select' || active.closest('ion-input, ion-textarea, ion-select');
    if (!isInput) return;

    active.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
  }

  private routeFromAppUrl(parsed: URL): string {
    if (parsed.protocol === 'com.movabi.app:') {
      const host = parsed.hostname ? `/${parsed.hostname}` : '';
      const path = parsed.pathname || '';
      return `${host}${path}${parsed.search}${parsed.hash}` || '/auth/callback';
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  }

  private safeUrl(value: string): URL | null {
    try {
      return new URL(value);
    } catch {
      return null;
    }
  }
}

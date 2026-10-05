import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Device } from '@capacitor/device';
import { Haptics, NotificationType } from '@capacitor/haptics';
import { Keyboard, KeyboardResize, KeyboardStyle } from '@capacitor/keyboard';
import { LocalNotifications } from '@capacitor/local-notifications';
import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar, Style } from '@capacitor/status-bar';

@Injectable({ providedIn: 'root' })
export class NativePlatformService {
  private router = inject(Router);
  private initialized = false;

  readonly isNative = Capacitor.isNativePlatform();
  readonly platform = Capacitor.getPlatform();
  readonly appIsActive = signal(true);

  async initialize(): Promise<void> {
    if (!this.isNative || this.initialized) return;
    this.initialized = true;

    await Promise.allSettled([
      StatusBar.setOverlaysWebView({ overlay: false }),
      StatusBar.setStyle({ style: Style.Light }),
      Keyboard.setResizeMode({ mode: KeyboardResize.Native }),
      Keyboard.setStyle({ style: KeyboardStyle.Light }),
      Keyboard.setScroll({ isDisabled: false }),
      Device.getInfo()
    ]);

    if (this.platform === 'android') {
      await StatusBar.setBackgroundColor({ color: '#F8FAFC' }).catch(() => undefined);
    }

    await this.configureKeyboardListeners();

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

    // OneSignal owns native push (FCM/APNs) delivery. The redundant
    // @capacitor/push-notifications registration is no longer performed.
    const localPermission = await LocalNotifications.requestPermissions();
    return localPermission.display === 'granted';
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

  private async configureKeyboardListeners(): Promise<void> {
    const show = (height?: number) => {
      document.body.classList.add('native-keyboard-open');
      if (height) document.documentElement.style.setProperty('--native-keyboard-height', `${height}px`);
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

import { ChangeDetectionStrategy, Component, inject, OnInit, signal } from '@angular/core';
import { Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { IonApp, IonRouterOutlet, IonIcon } from '@ionic/angular/standalone';
import { App as CapacitorApp } from '@capacitor/app';
import { Browser } from '@capacitor/browser';

import { SupabaseService } from './core/services/supabase/supabase.service';
import { AppConfigService } from './core/services/config/app-config.service';
import { NetworkService } from './core/services/network/network.service';
import { NativePlatformService } from './core/services/native/native-platform.service';
import { NotificationService } from './core/services/notification.service';
import { MovabiTourOverlayComponent } from './shared/ui/movabi-tour-overlay.component';

import { addIcons } from 'ionicons';
import {
    addOutline,
    alertCircle,
    alertCircleOutline,
    analyticsOutline,
    arrowForward,
    bus,
    busOutline,
    businessOutline,
    calendarClearOutline,
    calendarOutline,
    calculatorOutline,
    call,
    car,
    carOutline,
    carSport,
    card,
    cardOutline,
    cart,
    chatbubbleOutline,
    chatbubbles,
    checkmark,
    checkmarkCircle,
    checkmarkCircleOutline,
    chevronBackOutline,
    chevronForward,
    closeOutline,
    createOutline,
    downloadOutline,
    eyeOffOutline,
    eyeOutline,
    flag,
    flashOutline,
    globeOutline,
    helpCircleOutline,
    informationCircleOutline,
    location,
    lockClosed,
    lockClosedOutline,
    logOutOutline,
    logoGoogle,
    mailOutline,
    mailUnreadOutline,
    map,
    moonOutline,
    navigate,
    navigateCircle,
    notificationsOutline,
    personAddOutline,
    personOutline,
    pin,
    receiptOutline,
    refreshOutline,
    ribbonOutline,
    searchOutline,
    send,
    settingsOutline,
    shieldCheckmark,
    shieldCheckmarkOutline,
    star,
    starOutline,
    statsChart,
    timeOutline,
    trashOutline,
    trendingUpOutline,
    wallet,
    walletOutline,
    warningOutline,
    informationCircle,
    locationOutline,
    locate,
    pinOutline,
    peopleOutline,
    cartOutline,
    cashOutline,
    constructOutline,
    cubeOutline,
    swapHorizontalOutline,
    closeCircleOutline,
    callOutline,
    homeOutline,
    storefrontOutline,
    layersOutline,
    cloudOfflineOutline,
} from 'ionicons/icons';

@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    selector: 'app-root',
    standalone: true,
    imports: [IonApp, IonRouterOutlet, IonIcon, CommonModule, MovabiTourOverlayComponent],
    template: `
    <ion-app>
      @if (!isConfigured) {
        <div class="fixed top-0 left-0 right-0 z-[1000] bg-amber-500 text-white p-4 text-center shadow-lg animate-bounce-slow">
          <div class="max-w-4xl mx-auto flex items-center justify-center gap-3">
            <ion-icon name="warning-outline" class="text-2xl"></ion-icon>
            <div>
              <p class="font-bold">Supabase Configuration Missing</p>
              <p class="text-xs opacity-90">
                Please set
                <code class="bg-amber-600 px-1 rounded">SUPABASE_URL</code>
                and
                <code class="bg-amber-600 px-1 rounded">SUPABASE_ANON_KEY</code>
                in the Settings menu.
              </p>
            </div>
          </div>
        </div>
      } @else if (!isOnline()) {
        <div class="fixed top-0 left-0 right-0 z-[1000] bg-rose-600 text-white p-3 text-center shadow-lg animate-in fade-in slide-in-from-top duration-300">
          <div class="max-w-4xl mx-auto flex items-center justify-center gap-2">
            <ion-icon name="cloud-offline-outline" class="text-xl"></ion-icon>
            <p class="text-sm font-semibold">
              You are currently offline. Some features may be unavailable.
            </p>
          </div>
        </div>
      }

      <ion-router-outlet></ion-router-outlet>
      <app-movabi-tour-overlay></app-movabi-tour-overlay>
    </ion-app>
  `,
    styleUrl: './app.css',
})
export class App implements OnInit {
    private supabase = inject(SupabaseService);
    private appConfig = inject(AppConfigService);
    private network = inject(NetworkService);
    private nativePlatform = inject(NativePlatformService);
    private notifications = inject(NotificationService);
    private router = inject(Router);

    isConfigured = this.supabase.isConfigured;
    isOnline = signal(this.network.isOnline);

    constructor() {
        addIcons({
            addOutline,
            alertCircle,
            alertCircleOutline,
            analyticsOutline,
            arrowForward,
            bus,
            busOutline,
            businessOutline,
            calendarClearOutline,
            calendarOutline,
            calculatorOutline,
            call,
            car,
            carOutline,
            carSport,
            card,
            cardOutline,
            cart,
            chatbubbleOutline,
            chatbubbles,
            checkmark,
            checkmarkCircle,
            checkmarkCircleOutline,
            chevronBackOutline,
            chevronForward,
            closeOutline,
            createOutline,
            downloadOutline,
            eyeOffOutline,
            eyeOutline,
            flag,
            flashOutline,
            globeOutline,
            helpCircleOutline,
            informationCircleOutline,
            location,
            lockClosed,
            lockClosedOutline,
            logOutOutline,
            logoGoogle,
            mailOutline,
            mailUnreadOutline,
            map,
            moonOutline,
            navigate,
            navigateCircle,
            notificationsOutline,
            personAddOutline,
            personOutline,
            pin,
            receiptOutline,
            refreshOutline,
            ribbonOutline,
            searchOutline,
            send,
            settingsOutline,
            shieldCheckmark,
            shieldCheckmarkOutline,
            star,
            starOutline,
            statsChart,
            timeOutline,
            trashOutline,
            trendingUpOutline,
            wallet,
            walletOutline,
            warningOutline,
            informationCircle,
            locationOutline,
            locate,
            pinOutline,
            peopleOutline,
            cartOutline,
            cashOutline,
            constructOutline,
            cubeOutline,
            swapHorizontalOutline,
            closeCircleOutline,
            callOutline,
            homeOutline,
            storefrontOutline,
            layersOutline,
            cloudOfflineOutline,
        });
    }

    async ngOnInit() {
        this.setupDeepLinkListener();

        await this.nativePlatform.initialize();

        this.network.isOnline$.subscribe((status) => this.isOnline.set(status));

        if (this.isConfigured) {
            await this.appConfig.refreshConfigs();
        }

        void this.appConfig.detectRuntimeCountry();
        this.notifications.initialize();
    }

    private setupDeepLinkListener() {
        CapacitorApp.addListener('appUrlOpen', async (event) => {
            console.log('[App] appUrlOpen:', event.url);

            try {
                await Browser.close();
            } catch {
                // Browser may already be closed.
            }

            try {
                const url = new URL(event.url);

                const isCustomSchemeCallback =
                    url.protocol === 'com.movabi.app:' &&
                    url.hostname === 'auth' &&
                    url.pathname === '/callback';

                const isLocalhostCallback =
                    (url.origin === 'https://localhost' || url.origin === 'http://localhost') &&
                    url.pathname === '/auth/callback';

                const isAnyAuthCallback = event.url.includes('/auth/callback') || event.url.includes('://auth/callback');

                if (isCustomSchemeCallback || isLocalhostCallback || isAnyAuthCallback) {
                    const callbackUrl = `/auth/callback${url.search || ''}${url.hash || ''}`;
                    console.log('[App] navigating to:', callbackUrl);
                    await this.router.navigateByUrl(callbackUrl, { replaceUrl: true });
                    return;
                }

                if (url.protocol === 'com.movabi.app:') {
                    const path = url.hostname === 'driver' ? '/driver' : url.pathname;
                    const query = url.search || '';

                    if (path === '/driver') {
                        const driverUrl = `${path}${query}`;
                        console.log('[App] navigating to:', driverUrl);
                        await this.router.navigateByUrl(driverUrl, { replaceUrl: true });
                    }
                }
            } catch (error) {
                console.error('[App] appUrlOpen parse error:', error);
            }
        });
    }
}

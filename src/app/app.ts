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
import { MovabiUpdateRequiredComponent } from './shared/ui/movabi-update-required.component';
import { AppVersionService } from './core/services/app-version.service';
import { MarketAvailabilityClientService, PublicMarketStatus } from './core/services/market-availability.service';

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
    imports: [IonApp, IonRouterOutlet, IonIcon, CommonModule, MovabiTourOverlayComponent, MovabiUpdateRequiredComponent],
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

      @if (startupMarket() && !startupMarket()!.customerAppEnabled) {
        <section class="fixed inset-0 z-[1200] bg-slate-950 text-white flex items-center justify-center p-6" aria-live="polite">
          <div class="max-w-lg w-full text-center space-y-5">
            <ion-icon name="globe-outline" class="text-6xl text-blue-400"></ion-icon>
            <h1 class="text-3xl font-black">{{ startupMarket()!.title }}</h1><p class="text-slate-300">{{ startupMarket()!.message }}</p>
            <label class="block text-left text-sm font-bold">Change location<select class="mt-2 w-full p-3 rounded-xl text-slate-900" [value]="appConfig.currentCountry().code" (change)="changeStartupCountry($any($event.target).value)">@for(country of appConfig.countries();track country.code){<option [value]="country.code">{{country.name}}</option>}</select></label>
            @if (startupMarket()!.waitingListEnabled) {<div class="flex gap-2"><input class="flex-1 p-3 rounded-xl text-slate-900" type="email" placeholder="Email for launch updates" [value]="waitingEmail()" (input)="waitingEmail.set($any($event.target).value)"><button class="px-4 rounded-xl bg-blue-600 font-bold" (click)="joinWaitingList()">Join</button></div>}
            @if (startupMessage()) {<p class="text-sm text-blue-300">{{startupMessage()}}</p>}
            <div class="flex gap-3 justify-center"><button class="px-5 py-3 rounded-xl bg-white text-slate-900 font-bold" (click)="checkStartupMarket()">Retry</button><button class="px-5 py-3 rounded-xl border border-white/30 font-bold" (click)="router.navigateByUrl('/auth/login')">Sign in</button></div>
          </div>
        </section>
      } @else if (startupMarket() && startupMarket()!.customerAppEnabled && !startupMarket()!.bookingEnabled) {
        <aside class="fixed top-0 left-0 right-0 z-[1100] bg-blue-700 text-white p-3 text-center"><strong>{{startupMarket()!.title}}</strong> — {{startupMarket()!.message}} <button class="underline ml-2" (click)="changeLocationVisible.set(!changeLocationVisible())">Change location</button>
          @if(changeLocationVisible()){<select class="ml-2 text-slate-900 p-1 rounded" [value]="appConfig.currentCountry().code" (change)="changeStartupCountry($any($event.target).value)">@for(country of appConfig.countries();track country.code){<option [value]="country.code">{{country.name}}</option>}</select>}
        </aside>
      }

      <ion-router-outlet></ion-router-outlet>
      <app-movabi-tour-overlay></app-movabi-tour-overlay>
      <app-movabi-update-required></app-movabi-update-required>
    </ion-app>
  `,
    styleUrl: './app.css',
})
export class App implements OnInit {
    private supabase = inject(SupabaseService);
    public appConfig = inject(AppConfigService);
    private network = inject(NetworkService);
    private nativePlatform = inject(NativePlatformService);
    private notifications = inject(NotificationService);
    private appVersion = inject(AppVersionService);
    public router = inject(Router);
    private marketAvailability = inject(MarketAvailabilityClientService);

    isConfigured = this.supabase.isConfigured;
    isOnline = signal(this.network.isOnline);
    startupMarket = signal<PublicMarketStatus|null>(null);
    startupMessage = signal<string|null>(null);
    waitingEmail = signal('');
    changeLocationVisible = signal(false);

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
        this.installFocusTransitionSafety();
        this.setupDeepLinkListener();

        await this.nativePlatform.initialize();
        this.appVersion.init();

        this.network.isOnline$.subscribe((status) => this.isOnline.set(status));

        if (this.isConfigured) {
            await this.appConfig.refreshConfigs();
        }

        await this.appConfig.detectRuntimeCountry();
        await this.checkStartupMarket();
        this.notifications.initialize();
    }

    private installFocusTransitionSafety() {
        const releaseFocus = (event: Event) => {
            const active = document.activeElement;
            const leavingSurface = event.target;
            if (active instanceof HTMLElement && leavingSurface instanceof HTMLElement && leavingSurface.contains(active)) active.blur();
        };
        document.addEventListener('ionViewWillLeave', releaseFocus, true);
        document.addEventListener('ionModalWillDismiss', releaseFocus, true);
        document.addEventListener('ionPopoverWillDismiss', releaseFocus, true);
    }

    async checkStartupMarket() {
        try { this.startupMessage.set(null); this.startupMarket.set(await this.marketAvailability.getStatus({countryCode:this.appConfig.currentCountry().code})); }
        catch { this.startupMessage.set('We could not check availability. Please retry.'); }
    }

    async changeStartupCountry(code:string) { this.appConfig.setCountry(code); this.changeLocationVisible.set(false); await this.checkStartupMarket(); }
    async joinWaitingList() { const status=this.startupMarket();if(!status)return;try{await this.marketAvailability.joinWaitingList(this.waitingEmail(),status);this.startupMessage.set('You are on the waiting list.');}catch(error:any){this.startupMessage.set(error?.error?.error||'Could not join the waiting list.');} }

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
                    const path = url.hostname === 'driver'
                        ? '/driver'
                        : `/${[url.hostname, url.pathname.replace(/^\/+/, '')].filter(Boolean).join('/')}`;
                    const targetUrl = `${path}${url.search || ''}${url.hash || ''}`;

                    if (path === '/driver' || path === '/auth/reset-password' || path === '/auth/callback') {
                        console.log('[App] navigating to:', targetUrl);
                        await this.router.navigateByUrl(targetUrl, { replaceUrl: true });
                    }
                }
            } catch (error) {
                console.error('[App] appUrlOpen parse error:', error);
            }
        });
    }
}

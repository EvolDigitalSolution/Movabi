import { ChangeDetectionStrategy, Component, inject, OnInit, signal } from '@angular/core';
import { IonApp, IonRouterOutlet, IonIcon } from '@ionic/angular/standalone';
import { SupabaseService } from './core/services/supabase/supabase.service';
import { AppConfigService } from './core/services/config/app-config.service';
import { NetworkService } from './core/services/network/network.service';
import { CommonModule } from '@angular/common';
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
    imports: [IonApp, IonRouterOutlet, IonIcon, CommonModule],
    template: `
    <ion-app>
      @if (!isConfigured) {
        <div class="fixed top-0 left-0 right-0 z-[1000] bg-amber-500 text-white p-4 text-center shadow-lg animate-bounce-slow">
          <div class="max-w-4xl mx-auto flex items-center justify-center gap-3">
            <ion-icon name="warning-outline" class="text-2xl"></ion-icon>
            <div>
              <p class="font-bold">Supabase Configuration Missing</p>
              <p class="text-xs opacity-90">Please set <code class="bg-amber-600 px-1 rounded">SUPABASE_URL</code> and <code class="bg-amber-600 px-1 rounded">SUPABASE_ANON_KEY</code> in the Settings menu.</p>
            </div>
          </div>
        </div>
      } @else if (!isOnline()) {
        <div class="fixed top-0 left-0 right-0 z-[1000] bg-rose-600 text-white p-3 text-center shadow-lg animate-in fade-in slide-in-from-top duration-300">
          <div class="max-w-4xl mx-auto flex items-center justify-center gap-2">
            <ion-icon name="cloud-offline-outline" class="text-xl"></ion-icon>
            <p class="text-sm font-semibold">You are currently offline. Some features may be unavailable.</p>
          </div>
        </div>
      }
      <ion-router-outlet></ion-router-outlet>
    </ion-app>
  `,
    styleUrl: './app.css',
})
export class App implements OnInit {
    private supabase = inject(SupabaseService);
    private appConfig = inject(AppConfigService);
    private network = inject(NetworkService);
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
        this.network.isOnline$.subscribe(status => this.isOnline.set(status));
        if (this.isConfigured) {
            await this.appConfig.refreshConfigs();
        }
    }
}

import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IonicModule } from '@ionic/angular';
import { AuthService } from '../../../../core/services/auth/auth.service';
import { RegistrationService } from '../../../../core/services/auth/registration.service';
import { AppConfigService } from '../../../../core/services/config/app-config.service';
import { MarketAvailabilityClientService, PublicMarketStatus } from '../../../../core/services/market-availability.service';
import { MarketAvailabilityFailure } from '../../../../shared/utils/market-failure';

/**
 * Confirm the country/area where the account will be used.
 *
 * Shown only while a signed-in identity has not yet been confirmed for Movabi in
 * a market we have launched. The server decides availability; this page simply
 * lets the user declare their country and retry.
 */
@Component({
  selector: 'app-auth-registration',
  standalone: true,
  imports: [IonicModule, CommonModule, FormsModule],
  template: `
    <ion-content class="ion-padding bg-slate-50">
      <div class="max-w-md mx-auto pt-6 space-y-6">
        <div class="text-center space-y-2">
          <div class="w-16 h-16 mx-auto bg-amber-50 rounded-[1.5rem] flex items-center justify-center border border-amber-100">
            <ion-icon name="location-outline" class="text-3xl text-amber-600"></ion-icon>
          </div>
          <h2 class="text-2xl font-display font-bold text-slate-900">Where will you use Movabi?</h2>
          <p class="text-slate-600 font-medium leading-relaxed">
            We're only available in some areas right now. Choose your country to continue.
          </p>
        </div>

        @if (statusUnknown()) {
          <div class="bg-orange-50 border border-orange-100 rounded-2xl p-4 space-y-3">
            <p class="text-sm font-semibold text-orange-800 leading-relaxed">
              We couldn't check your registration right now. Check your connection and try again.
            </p>
            <ion-button expand="block" class="h-11 font-bold" (click)="retry()">
              Try again
            </ion-button>
          </div>
        }

        <div class="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 space-y-4">
          <div>
            <label for="registrationCountry" class="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">Country</label>
            <ion-select
              id="registrationCountry"
              interface="action-sheet"
              class="w-full"
              [value]="countryCode()"
              (ionChange)="onCountryChange($any($event).detail?.value ?? $any($event).target?.value)"
            >
              @for (country of appConfig.countries(); track country.code) {
                <ion-select-option [value]="country.code">{{ country.name }}</ion-select-option>
              }
            </ion-select>
          </div>

          <div>
            <label for="registrationCity" class="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2">
              City or area <span class="normal-case font-medium text-slate-400">(optional)</span>
            </label>
            <ion-input
              id="registrationCity"
              class="w-full"
              placeholder="e.g. London or Manchester"
              [value]="marketCity()"
              (ionInput)="marketCity.set($any($event).detail?.value ?? '')"
            ></ion-input>
          </div>

          @if (errorMessage()) {
            <div class="rounded-xl bg-orange-50 border border-orange-100 p-3">
              <p class="text-sm font-semibold text-orange-800">{{ errorMessage() }}</p>
            </div>
          }

          <ion-button expand="block" class="h-12 font-bold" [disabled]="submitting()" (click)="confirm()">
            {{ submitting() ? 'Checking…' : 'Continue' }}
          </ion-button>
        </div>

        @if (unavailableMarket()?.waitingListEnabled) {
          <div class="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 space-y-3">
            <p class="text-sm font-bold text-slate-900">Not available yet?</p>
            <p class="text-xs text-slate-500 font-medium">Leave your email and we'll let you know when Movabi arrives.</p>
            <div class="flex gap-2">
              <ion-input
                class="flex-1"
                type="email"
                placeholder="you@example.com"
                [value]="waitingEmail()"
                (ionInput)="waitingEmail.set($any($event).detail?.value ?? '')"
              ></ion-input>
              <ion-button [disabled]="joinedWaitingList()" (click)="joinWaitingList()">
                {{ joinedWaitingList() ? 'Added' : 'Notify me' }}
              </ion-button>
            </div>
            @if (waitlistMessage()) {
              <p class="text-xs font-semibold text-emerald-700">{{ waitlistMessage() }}</p>
            }
          </div>
        }

        <ion-button fill="clear" expand="block" class="font-bold" (click)="signOut()">
          Sign out
        </ion-button>
      </div>
    </ion-content>
  `
})
export class RegistrationPage implements OnInit {
  private auth = inject(AuthService);
  private registration = inject(RegistrationService);
  private marketAvailability = inject(MarketAvailabilityClientService);
  public appConfig = inject(AppConfigService);

  countryCode = signal(this.appConfig.currentCountry().code);
  marketCity = signal('');
  submitting = signal(false);
  errorMessage = signal<string | null>(null);
  unavailableMarket = signal<PublicMarketStatus | null>(null);
  waitingEmail = signal('');
  waitingListEnabled = signal(false);
  joinedWaitingList = signal(false);
  waitlistMessage = signal<string | null>(null);
  statusUnknown = signal(false);

  ngOnInit(): void {
    // Already confirmed for a launched market: continue the normal flow.
    const state = this.registration.state();
    if (state?.activated) {
      void this.auth.handlePostAuthRedirect();
      return;
    }

    // A status read that failed must be surfaced as a retryable "can't check"
    // state — never as "unsupported" or "pending".
    this.statusUnknown.set(this.registration.statusUnavailable());
  }

  /** Re-read the authoritative status after a failed check. */
  async retry(): Promise<void> {
    this.statusUnknown.set(false);
    const state = await this.registration.ensureLoaded(true);
    if (state?.activated) {
      await this.auth.handlePostAuthRedirect();
      return;
    }
    this.statusUnknown.set(this.registration.statusUnavailable());
  }

  onCountryChange(code: string): void {
    const next = String(code || '').trim();
    if (!next || next === this.countryCode()) return;
    this.countryCode.set(next);
    this.appConfig.setCountry(next);
    // An area belongs to the previously selected country.
    this.marketCity.set('');
    this.errorMessage.set(null);
    this.unavailableMarket.set(null);
  }

  async confirm(): Promise<void> {
    if (this.submitting()) return;

    this.submitting.set(true);
    this.errorMessage.set(null);
    this.unavailableMarket.set(null);

    try {
      const state = await this.registration.resolve({ countryCode: this.countryCode(), marketCity: this.marketCity() });
      if (state.activated) {
        await this.auth.handlePostAuthRedirect();
        return;
      }
      this.errorMessage.set('We could not confirm Movabi in that area yet. Please check your country and try again.');
    } catch (error) {
      if (error instanceof MarketAvailabilityFailure) {
        this.errorMessage.set(error.message);
        await this.loadUnavailableMarket();
      } else {
        this.errorMessage.set(error instanceof Error ? error.message : 'Something went wrong. Please try again.');
      }
    } finally {
      this.submitting.set(false);
    }
  }

  /** Best-effort: only used to offer the launch-notification option. */
  private async loadUnavailableMarket(): Promise<void> {
    try {
      const status = await this.marketAvailability.getStatus({ countryCode: this.countryCode(), marketCity: this.marketCity() });
      this.unavailableMarket.set(status);
    } catch {
      this.unavailableMarket.set(null);
    }
  }

  async joinWaitingList(): Promise<void> {
    if (this.joinedWaitingList()) return;

    const email = String(this.waitingEmail() || '').trim();
    if (!email) {
      this.waitlistMessage.set('Enter an email address first.');
      return;
    }

    try {
      const status = this.unavailableMarket() || this.marketAvailability.current();
      if (!status) {
        this.waitlistMessage.set('Please try again in a moment.');
        return;
      }
      await this.marketAvailability.joinWaitingList(email, status);
      this.joinedWaitingList.set(true);
      this.waitlistMessage.set("Thanks — we'll be in touch when Movabi launches near you.");
    } catch {
      this.waitlistMessage.set('We could not save that right now. Please try again.');
    }
  }

  async signOut(): Promise<void> {
    await this.auth.signOut();
  }
}

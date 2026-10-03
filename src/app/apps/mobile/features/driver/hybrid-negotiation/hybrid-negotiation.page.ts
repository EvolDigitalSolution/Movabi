import {
    Component,
    inject,
    OnInit,
    OnDestroy,
    signal,
    computed
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
    canDriver,
    deadlineKey,
    deadlineRemainingMs,
    formatRemaining as formatDeadlineRemaining,
    getNegotiationState,
    isLiveOwnedNegotiation,
    type NegotiationAction,
    type NegotiationState
} from '@shared/marketplace/negotiation-state';
import { IonicModule, LoadingController, ToastController } from '@ionic/angular';
import { ActivatedRoute, Router } from '@angular/router';
import { addIcons } from 'ionicons';
import {
    callOutline,
    checkmarkCircleOutline,
    chevronBackOutline,
    closeCircleOutline,
    navigateOutline,
    personOutline,
    pricetagOutline,
    sendOutline,
    timeOutline,
    timerOutline
} from 'ionicons/icons';
import { MarketplaceHybridService } from '@core/services/marketplace/marketplace-hybrid.service';
import { MarketplaceConfigService, MarketplaceEffectiveHybridStatus } from '@core/services/marketplace/marketplace-config.service';
import { SupabaseService } from '@core/services/supabase/supabase.service';
import { AuthService } from '@core/services/auth/auth.service';
import { AppConfigService } from '@core/services/config/app-config.service';

@Component({
    selector: 'app-hybrid-negotiation',
    standalone: true,
    imports: [CommonModule, FormsModule, IonicModule],
    template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-4 bg-white">
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/driver" text="" icon="chevron-back-outline"></ion-back-button>
        </ion-buttons>
        <ion-title class="font-display font-bold text-slate-900">Negotiate Fare</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="movabi-page" [fullscreen]="true">
      @if (session(); as s) {
        <div class="px-4 pt-4 pb-8">
          <!-- Customer identity card -->
          <div class="bg-gradient-to-br from-white to-amber-50 rounded-3xl border border-amber-100 shadow-lg p-5 mb-4">
            <div class="flex items-center gap-4">
              <div class="w-14 h-14 rounded-full bg-amber-100 flex items-center justify-center text-amber-600">
                <ion-icon name="person-outline" class="text-2xl"></ion-icon>
              </div>
              <div class="flex-1">
                <h3 class="text-lg font-display font-bold text-slate-900">{{ customerName() }}</h3>
                <p class="text-sm text-slate-500 font-medium">{{ completedTrips() }} completed trips</p>
              </div>
              <div class="text-right">
                <p class="text-2xl font-display font-black text-amber-600">{{ customerRating() }}</p>
                <p class="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Rating</p>
              </div>
            </div>
            @if (customerPhone()) {
              <p class="text-sm text-slate-600 font-medium mt-3 flex items-center gap-2">
                <ion-icon name="call-outline" class="text-amber-500"></ion-icon>
                {{ customerPhone() }}
              </p>
            }
            @if (jobDistanceEta()) {
              <p class="text-xs text-slate-500 font-medium mt-2 flex items-center gap-2">
                <ion-icon name="navigate-outline" class="text-amber-500"></ion-icon>
                {{ jobDistanceEta() }}
              </p>
            }
          </div>

          <!-- Fare details -->
          <div class="bg-white rounded-3xl border border-slate-100 shadow-sm p-5 mb-4">
            <p class="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Suggested Fare</p>
            <p class="text-4xl font-display font-black text-slate-900">{{ formatPrice(s.suggested_fare) }}</p>

            @if (s.customer_offer) {
              <div class="mt-4 bg-emerald-50 rounded-2xl border border-emerald-100 p-4">
                <p class="text-[10px] font-black uppercase tracking-widest text-emerald-600 mb-1">Customer Offer</p>
                <p class="text-2xl font-display font-black text-emerald-900">{{ formatPrice(s.customer_offer) }}</p>
              </div>
            }

            @if (s.driver_counter_offer) {
              <div class="mt-4 bg-amber-50 rounded-2xl border border-amber-100 p-4">
                <p class="text-[10px] font-black uppercase tracking-widest text-amber-600 mb-1">Your Counter</p>
                <p class="text-2xl font-display font-black text-amber-900">{{ formatPrice(s.driver_counter_offer) }}</p>
              </div>
            }

            <div class="flex items-center gap-2 mt-4 text-sm text-slate-500 font-medium">
              <ion-icon name="timer-outline" class="text-amber-500"></ion-icon>
              <span>Round {{ s.round_count || 0 }}</span>
              @if (expiresAt()) {
                <span class="ml-auto">Expires in {{ formatCountdown(expiresAt()) }}</span>
              }
            </div>
          </div>

          <!-- Action buttons -->
          @if (s.status === 'open' || s.status === 'released') {
            <div class="space-y-3 mb-4">
              <button
                type="button"
                (click)="startNegotiation()"
                class="w-full py-4 bg-gradient-to-r from-amber-500 to-orange-500 text-white rounded-3xl font-black text-lg active:scale-95 transition-all shadow-lg flex items-center justify-center gap-3"
              >
                <ion-icon name="pricetag-outline" class="text-xl"></ion-icon>
                Start Negotiation
              </button>
              <button
                type="button"
                (click)="acceptSuggested()"
                class="w-full py-4 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white rounded-3xl font-black text-lg active:scale-95 transition-all shadow-lg flex items-center justify-center gap-3"
              >
                <ion-icon name="checkmark-circle-outline" class="text-xl"></ion-icon>
                Accept Suggested Fare
              </button>
              <button
                type="button"
                (click)="pass()"
                class="w-full py-4 bg-white border-2 border-slate-200 text-slate-700 rounded-3xl font-black text-lg active:scale-95 transition-all flex items-center justify-center gap-3"
              >
                <ion-icon name="close-circle-outline" class="text-xl"></ion-icon>
                Pass
              </button>
            </div>
          }

          @if (s.status === 'driver_claimed' || s.status === 'negotiating') {
            <div class="space-y-3 mb-4">
              @if (canDriver('accept')) {
                <button
                  type="button"
                  (click)="acceptOffer()"
                  [disabled]="mutationBusy()"
                  class="w-full py-4 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white rounded-3xl font-black text-lg active:scale-95 transition-all shadow-lg flex items-center justify-center gap-3 disabled:opacity-50"
                >
                  <ion-icon name="checkmark-circle-outline" class="text-xl"></ion-icon>
                  Accept Customer Offer
                </button>
              }

              @if (canDriver('counter')) {
              <div class="bg-white rounded-2xl border border-slate-100 p-4">
                <label class="text-sm font-bold text-slate-700 mb-2 block">Your counter offer</label>
                <input
                  type="number"
                  [(ngModel)]="counterAmount"
                  class="w-full py-3 px-4 border border-slate-200 rounded-2xl font-display font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500"
                  [placeholder]="'Enter amount'"
                />
                <button
                  type="button"
                  (click)="submitCounter()"
                  [disabled]="mutationBusy() || !counterAmount() || counterAmount() <= 0"
                  class="w-full mt-3 py-3 bg-gradient-to-r from-amber-500 to-orange-500 text-white rounded-2xl font-bold text-base active:scale-95 transition-all shadow-lg disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  <ion-icon name="send-outline" class="text-lg"></ion-icon>
                  Send Counter
                </button>
              </div>
              }

              @if (canDriver('release')) {
              <button
                type="button"
                (click)="pass()"
                [disabled]="mutationBusy()"
                class="w-full py-4 bg-white border-2 border-red-200 text-red-700 rounded-3xl font-black text-lg active:scale-95 transition-all flex items-center justify-center gap-3 disabled:opacity-50"
              >
                <ion-icon name="close-circle-outline" class="text-xl"></ion-icon>
                Pass
              </button>
              }
            </div>
          }

          @if (s.status === 'fare_agreed') {
            <div class="bg-emerald-50 rounded-3xl border border-emerald-100 p-6 text-center">
              <ion-icon name="checkmark-circle-outline" class="text-5xl text-emerald-500 mb-3"></ion-icon>
              <h3 class="text-xl font-bold text-emerald-900 mb-2">Fare Agreed!</h3>
              @if (negotiationState().paymentExpired) {
                <p class="text-rose-700 font-medium">Payment window expired. Releasing this agreement…</p>
              } @else {
                <p class="text-emerald-700 font-medium">Customer has {{ formatRemaining(paymentCountdown()) }} to complete payment.</p>
              }
            </div>
          }
        </div>
      } @else {
        <div class="h-full flex items-center justify-center p-6">
          <p class="text-slate-500 font-semibold">Loading negotiation...</p>
        </div>
      }
    </ion-content>
  `
})
export class DriverHybridNegotiationPage implements OnInit, OnDestroy {
    private route = inject(ActivatedRoute);
    private router = inject(Router);
    private hybridService = inject(MarketplaceHybridService);
    private marketplaceConfig = inject(MarketplaceConfigService);
    private supabase = inject(SupabaseService);
    private auth = inject(AuthService);
    private config = inject(AppConfigService);
    private loadingCtrl = inject(LoadingController);
    private toastCtrl = inject(ToastController);

    get hybridEnabled(): boolean {
        return this.effectiveHybridStatus()?.enabled === true;
    }

    jobId = signal<string>('');
    session = signal<any>(null);
    events = signal<any[]>([]);

    /**
     * Patch 1A — CANONICAL negotiation state (same helper as the customer page).
     *
     * The driver's available actions come from PERSISTED session + events, so the
     * driver is offered accept/counter/release only when the live fare proposal is
     * the CUSTOMER's. On the customer's turn no driver mutation control is offered.
     * Lifecycle events (session_claimed etc.) never transfer the turn.
     */
    readonly negotiationState = computed<NegotiationState>(() =>
        // leaseClock() is a wall-clock tick so canonical state re-derives when the
        // per-driver LEASE expires (Realtime emits nothing for elapsed time).
        getNegotiationState(this.session(), this.events(), this.leaseClock())
    );

    /**
     * AUTHORITATIVE payment countdown (ms) — the SAME persisted
     * marketplace_negotiation_sessions.payment_deadline the customer sees, so both
     * parties converge on one deadline. A 1-second display clock only; no polling.
     */
    readonly paymentCountdown = computed<number>(() => {
        const session = this.session();
        if (!session || this.negotiationState().phase !== 'agreed_payment_required') return 0;
        const raw = (session as any)?.payment_deadline ?? (session as any)?.expires_at ?? null;
        return deadlineRemainingMs(raw, this.leaseClock());
    });

    /** True only when the canonical state permits this driver action. */
    canDriver(action: NegotiationAction): boolean {
        return canDriver(this.negotiationState(), action);
    }

    /**
     * UX-only double-submit guard for driver negotiation mutations (accept /
     * counter / release). The database RPC transitions remain the real authority;
     * this merely disables buttons and ignores repeated clicks while a call is in
     * flight. It must never gate initial page load.
     */
    mutationBusy = signal<boolean>(false);
    effectiveHybridStatus = signal<MarketplaceEffectiveHybridStatus | null>(null);
    counterAmount = signal<number>(0);
    customerProfile = signal<any>(null);
    jobDetails = signal<any>(null);
    private countdownInterval: any;
    expiresAt = signal<number>(0);

    constructor() {
        addIcons({
            callOutline,
            checkmarkCircleOutline,
            closeCircleOutline,
            navigateOutline,
            personOutline,
            pricetagOutline,
            sendOutline,
            timeOutline,
            timerOutline
        });
    }

    async ngOnInit() {
        await this.hybridService.loadSettings();
        const id = this.route.snapshot.paramMap.get('id');
        if (!id) {
            await this.router.navigate(['/driver']);
            return;
        }
        this.jobId.set(id);
        await this.load();
        if (!this.hybridEnabled) {
            // Distinguish UNKNOWN configuration from EXPLICITLY DISABLED configuration.
            //
            // `effectiveHybridStatus` is resolved from the driver-side `jobs` SELECT,
            // which production RLS correctly denies while this driver is only
            // `active_driver_id` on the session (jobs.driver_id is still NULL and the
            // job is `pending_fare_confirmation`). Unknown must NOT be treated as
            // disabled when authoritative session state proves this driver already
            // owns a LIVE, non-expired, non-terminal negotiation — otherwise a driver
            // can never reopen the negotiation they own.
            //
            // An explicitly disabled configuration (a resolved status with
            // enabled === false) is NEVER converted into an allowed one.
            const configurationUnknown = this.effectiveHybridStatus() === null;
            const recoverableOwnedSession = configurationUnknown && isLiveOwnedNegotiation(
                this.session(),
                this.auth.currentUser()?.id,
                this.events()
            );

            if (!recoverableOwnedSession) {
                await this.router.navigate(['/driver']);
                return;
            }

            console.warn('[HybridNegotiation] configuration undetermined (ancillary jobs read unavailable); recovering owned live negotiation', {
                jobId: id,
                sessionId: this.session()?.id ?? null,
                phase: this.negotiationState().phase
            });
        }
        this.startCountdown();
        this.ensureRealtimeSubscription();
        this.startLeaseTimer();
    }

    // ---------------------------------------------------------------------
    // Scoped live convergence for THIS negotiation session.
    // ---------------------------------------------------------------------

    private realtimeDispose: (() => void) | null = null;
    private realtimeSessionId: string | null = null;
    /** Monotonic token: a stale async reload must never overwrite newer state. */
    private reloadToken = 0;

    /** Wall-clock tick fed into getNegotiationState() so lease expiry is visible. */
    private leaseClock = signal<number>(Date.now());
    private leaseTimer?: any;
    private leaseReconciledFor: string | null = null;

    /** Post-payment navigation guard: navigate away from this page AT MOST once. */
    private lifecycleResolved = false;
    /** Scoped live JOB subscription so payment finalization is observed (session-only changes are already covered). */
    private jobRealtimeDispose: (() => void) | null = null;

    private startLeaseTimer(): void {
        this.stopLeaseTimer();
        this.leaseTimer = setInterval(() => {
            this.leaseClock.set(Date.now());

            const session = this.session();
            const expiresAt = String((session as any)?.expires_at ?? '').trim();
            if (!session || !expiresAt) return;

            const parsed = Date.parse(expiresAt);
            if (!Number.isFinite(parsed) || parsed > Date.now()) {
                this.leaseReconciledFor = null;
                return;
            }

            // Reconcile ONCE per lapsed lease; the authoritative reload reveals
            // whether the request was released back to the market.
            const key = deadlineKey(session.id, expiresAt);
            if (!key || this.leaseReconciledFor === key) return;
            this.leaseReconciledFor = key;
            void this.reconcile();
        }, 1000);
    }

    private stopLeaseTimer(): void {
        if (this.leaseTimer) {
            clearInterval(this.leaseTimer);
            this.leaseTimer = undefined;
        }
    }

    /**
     * Authoritative reload of session + event ledger (+ customer profile).
     * Realtime callbacks request THIS — they never inject optimistic state — and a
     * monotonic token discards a reload superseded while it was in flight.
     */
    private async reconcile(): Promise<void> {
        const jobId = this.jobId();
        if (!jobId) return;
        const token = ++this.reloadToken;
        try {
            const session = await this.hybridService.getSessionByJob(jobId);
            if (token !== this.reloadToken) return;
            this.session.set(session);
            if (!session) {
                // Session is gone (released/cancelled away) — confirm via the job.
                await this.loadJobDetails(jobId);
                if (token !== this.reloadToken) return;
                this.checkForActiveJobTransition();
                return;
            }

            const events = await this.hybridService.getSessionEvents(session.id);
            if (token !== this.reloadToken) return;
            this.events.set(events);

            // Reload the AUTHORITATIVE job (status/payment/driver) so payment
            // finalization and customer cancellation are observed, not inferred.
            await this.loadJobDetails(jobId);
            if (token !== this.reloadToken) return;

            await this.loadCustomerProfile(session.customer_id);
            if (token !== this.reloadToken) return;
            this.ensureRealtimeSubscription();
            this.ensureJobRealtimeSubscription();
            this.checkForActiveJobTransition();
        } catch (error) {
            console.warn('[HybridNegotiation] reconcile failed', error);
        }
    }

    /**
     * Establish (or RE-establish) the ONE scoped subscription for this session.
     * Idempotent per session id, so re-entry cannot accumulate duplicate channels.
     */
    private ensureRealtimeSubscription(): void {
        const sessionId = String(this.session()?.id ?? '').trim();
        if (!sessionId) return;
        if (this.realtimeSessionId === sessionId && this.realtimeDispose) return;

        this.disposeRealtimeSubscription();
        this.realtimeSessionId = sessionId;
        this.realtimeDispose = this.hybridService.subscribeToNegotiation(sessionId, () => {
            void this.reconcile();
        });
    }

    private disposeRealtimeSubscription(): void {
        try { this.realtimeDispose?.(); } catch { /* already disposed */ }
        this.realtimeDispose = null;
        this.realtimeSessionId = null;
    }

    ngOnDestroy() {
        this.disposeRealtimeSubscription();
        this.disposeJobRealtimeSubscription();
        this.stopLeaseTimer();
        if (this.countdownInterval) {
            clearInterval(this.countdownInterval);
        }
    }

    customerName(): string {
        const p = this.customerProfile();
        return p?.first_name || p?.full_name || 'Customer';
    }

    customerPhone(): string {
        return this.customerProfile()?.phone || this.customerProfile()?.phone_number || '';
    }

    customerRating(): string {
        const p = this.customerProfile();
        const rating = p?.rating || p?.average_rating || 0;
        return rating ? Number(rating).toFixed(1) : '—';
    }

    completedTrips(): number {
        const p = this.customerProfile();
        return p?.completed_trips || p?.completed_bookings || 0;
    }

    jobDistanceEta(): string {
        const job = this.jobDetails();
        if (!job) return '';
        const distance = job.distance_km ?? job.estimated_distance_km ?? 0;
        const duration = job.duration_seconds ?? job.estimated_duration ?? null;
        if (distance && duration) {
            return `${Number(distance).toFixed(1)} km · ${Math.round(duration / 60)} min`;
        }
        if (distance) return `${Number(distance).toFixed(1)} km`;
        if (duration) return `${Math.round(duration / 60)} min`;
        return '';
    }

    formatPrice(amount: number | string | null | undefined): string {
        return this.config.formatCurrency(Number(amount || 0));
    }

    /** Shared zero-padded MM:SS for the AUTHORITATIVE payment countdown. */
    formatRemaining(ms: number): string {
        return formatDeadlineRemaining(ms);
    }

    formatCountdown(ms: number): string {
        const totalSeconds = Math.max(0, Math.floor(ms / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    private startCountdown() {
        if (this.countdownInterval) clearInterval(this.countdownInterval);
        const update = () => {
            const session = this.session();
            if (!session?.expires_at) {
                this.expiresAt.set(0);
                return;
            }
            const remaining = new Date(session.expires_at).getTime() - Date.now();
            this.expiresAt.set(remaining);
        };
        update();
        this.countdownInterval = setInterval(update, 1000);
    }

    private async load() {
        try {
            const session = await this.hybridService.getSessionByJob(this.jobId());
            this.session.set(session);
            await this.loadJobDetails(this.jobId());
            this.ensureJobRealtimeSubscription();
            this.checkForActiveJobTransition();
            if (session) {
                const events = await this.hybridService.getSessionEvents(session.id);
                this.events.set(events);
                await this.loadCustomerProfile(session.customer_id);
                this.ensureRealtimeSubscription();
            }
        } catch (error) {
            console.error('[HybridNegotiation] load failed', error);
            await this.showToast('Unable to load negotiation.', 'danger');
        }
    }

    private async loadJobDetails(jobId: string) {
        try {
            const { data, error } = await this.supabase
                .from('jobs')
                .select('status, payment_status, driver_id, distance_km, estimated_distance_km, duration_seconds, estimated_duration, service_type:service_types(*)')
                .eq('id', jobId)
                .maybeSingle();
            if (!error) {
                this.jobDetails.set(data);
                const slug = String((data as any)?.service_type?.slug || '').trim();
                if (slug) {
                    this.effectiveHybridStatus.set(await this.marketplaceConfig.getEffectiveHybridStatus(slug));
                }
            }
        } catch (error) {
            console.warn('[HybridNegotiation] job details load failed', error);
        }
    }

    /**
     * POST-PAYMENT / CANCELLATION CONVERGENCE.
     *
     * After an AUTHORITATIVE job reload this decides the page's lifecycle. It never
     * reads a raw Realtime payload and never navigates from fare_agreed / countdown /
     * customer state alone — only the persisted job + session, and only once.
     */
    private checkForActiveJobTransition(): void {
        if (this.lifecycleResolved) return;
        const job = this.jobDetails();
        const driverId = this.auth.currentUser()?.id;
        if (!job || !driverId) return;

        const status = String((job as any)?.status ?? '').toLowerCase();
        const paymentStatus = String((job as any)?.payment_status ?? '').toLowerCase();
        const sessionStatus = String((this.session() as any)?.status ?? '').toLowerCase();

        // CUSTOMER CANCELLATION / TERMINAL — never leave the driver on a stale screen.
        if (['cancelled', 'canceled'].includes(status) || sessionStatus === 'customer_declined') {
            this.leaveToHub('This request was cancelled by the customer.');
            return;
        }
        if (['expired', 'completed'].includes(status) || sessionStatus === 'expired') {
            this.leaveToHub('This request is no longer available.');
            return;
        }

        // AUTHORITATIVE ACTIVE PAID ASSIGNMENT owned by this driver.
        if (status === 'assigned' && paymentStatus === 'authorized' && (job as any)?.driver_id === driverId) {
            this.lifecycleResolved = true;
            void this.router.navigate(['/driver/job-details', this.jobId()]);
        }
    }

    private leaveToHub(message: string): void {
        if (this.lifecycleResolved) return;
        this.lifecycleResolved = true;
        this.stopLeaseTimer();
        if (this.countdownInterval) {
            clearInterval(this.countdownInterval);
            this.countdownInterval = null;
        }
        void this.showToast(message, 'warning');
        void this.router.navigate(['/driver']);
    }

    /** Observe the job's own authoritative transition (payment finalization writes jobs, not the session). */
    private ensureJobRealtimeSubscription(): void {
        const jobId = this.jobId();
        if (!jobId || this.jobRealtimeDispose) return;
        const channel = this.supabase
            .channel(`negotiation-job-${jobId}`)
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'jobs', filter: `id=eq.${jobId}` }, () => {
                void this.reconcile();
            })
            .subscribe();
        this.jobRealtimeDispose = () => { try { channel.unsubscribe(); } catch { /* already disposed */ } };
    }

    private disposeJobRealtimeSubscription(): void {
        try { this.jobRealtimeDispose?.(); } catch { /* already disposed */ }
        this.jobRealtimeDispose = null;
    }

    private async loadCustomerProfile(customerId: string) {
        try {
            const { data, error } = await this.supabase
                .from('profiles')
                .select('*')
                .eq('id', customerId)
                .single();
            if (!error) this.customerProfile.set(data);
        } catch (error) {
            console.warn('[HybridNegotiation] customer profile failed', error);
        }
    }

    async startNegotiation() {
        const user = this.auth.currentUser();
        if (!user?.id) return;
        const loading = await this.loadingCtrl.create({ message: 'Claiming negotiation...' });
        try {
            await loading.present();
            const session = await this.hybridService.claimSession(this.jobId(), user.id);
            this.session.set(session);
            await this.showToast('Negotiation started! Make your offer or accept.', 'success');
            await this.reconcile();
            this.ensureRealtimeSubscription();
        } catch (error: any) {
            console.error('[HybridNegotiation] claim failed', error);
            await this.showToast(error.message || 'Another driver may already be negotiating.', 'danger');
        } finally {
            // GUARANTEED cleanup: no rejection may leave the overlay on screen.
            try { await loading.dismiss(); } catch { /* already dismissed */ }
        }
    }

    async acceptSuggested() {
        const user = this.auth.currentUser();
        if (!user?.id) return;
        const loading = await this.loadingCtrl.create({ message: 'Locking fare...' });
        try {
            await loading.present();
            const session = this.session();
            const amount = session?.suggested_fare || 0;
            const updated = await this.hybridService.lockFare(this.jobId(), user.id, amount);
            this.session.set(updated);
            await this.showToast('Suggested fare accepted! Waiting for customer payment.', 'success');
            await this.reconcile();
        } catch (error: any) {
            console.error('[HybridNegotiation] accept suggested failed', error);
            await this.showToast(error.message || 'Unable to accept fare.', 'danger');
        } finally {
            try { await loading.dismiss(); } catch { /* already dismissed */ }
        }
    }

    async pass() {
        if (this.mutationBusy()) return;
        const user = this.auth.currentUser();
        if (!user?.id) return;
        this.mutationBusy.set(true);
        const loading = await this.loadingCtrl.create({ message: 'Releasing...' });
        try {
            await loading.present();
            await this.hybridService.releaseSession(this.jobId(), user.id, 'pass');
            await this.showToast('You passed. The request will go to the next driver.', 'success');
            await this.router.navigate(['/driver']);
        } catch (error: any) {
            console.error('[HybridNegotiation] pass failed', error);
            await this.showToast(error.message || 'Unable to pass.', 'danger');
        } finally {
            try { await loading.dismiss(); } catch { /* already dismissed */ }
            this.mutationBusy.set(false);
        }
    }

    async acceptOffer() {
        if (this.mutationBusy()) return;
        const user = this.auth.currentUser();
        if (!user?.id) return;
        this.mutationBusy.set(true);
        try {
            const session = this.session();
            if (!session) return;
            const updated = await this.hybridService.acceptCustomerOffer(session.id);
            this.session.set(updated);
            await this.load(); // persisted authoritative reload of session + events + job
            await this.showToast('Offer accepted! Waiting for customer payment.', 'success');
        } catch (error: any) {
            console.error('[HybridNegotiation] accept offer failed', error);
            // A failed mutation must not leave the UI looking settled: reconcile
            // from persisted state so the card reflects the authoritative session.
            await this.load();
            await this.showToast(error.message || 'Unable to accept offer.', 'danger');
        } finally {
            this.mutationBusy.set(false);
        }
    }

    async submitCounter() {
        if (this.mutationBusy()) return;
        const amount = this.counterAmount();
        if (!amount || amount <= 0) {
            await this.showToast('Please enter a valid amount.', 'warning');
            return;
        }
        this.mutationBusy.set(true);
        try {
            const session = this.session();
            if (!session) return;
            const updated = await this.hybridService.driverCounterOffer(session.id, amount);
            this.session.set(updated);
            this.counterAmount.set(0);
            await this.load(); // persisted authoritative reload (events now include driver_counter)
            await this.showToast('Counter offer sent.', 'success');
        } catch (error: any) {
            console.error('[HybridNegotiation] counter failed', error);
            await this.showToast(error.message || 'Unable to send counter.', 'danger');
        } finally {
            this.mutationBusy.set(false);
        }
    }

    private async showToast(message: string, color: 'success' | 'warning' | 'danger' = 'success') {
        try {
            const toast = await this.toastCtrl.create({ message, duration: 3000, position: 'top', color });
            await toast.present();
        } catch (error) {
            console.warn('[HybridNegotiation] toast failed', error);
        }
    }
}

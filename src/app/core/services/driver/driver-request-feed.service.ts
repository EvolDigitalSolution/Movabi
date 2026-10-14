import { Injectable, computed, effect, inject, signal, DestroyRef } from '@angular/core';
import { Router, NavigationEnd } from '@angular/router';
import { filter, timer } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DriverService } from './driver.service';
import { AuthService } from '../auth/auth.service';
import { BookingService } from '../booking/booking.service';
import { actionableDriverRequests, liveRequestSelection, driverHasCurrentWork } from '@shared/utils/driver-request-feed';
import { Booking } from '@shared/models/booking.model';

@Injectable({ providedIn: 'root' })
export class DriverRequestFeedService {
    readonly driver = inject(DriverService);
    private auth = inject(AuthService);
    private router = inject(Router);
    private bookings = inject(BookingService);
    private route = signal(this.router.url);
    private seen = new Set<string>();
    private owner: string | null = this.auth.currentUser()?.id || null;
    private fetching = false;
    private hydrated = signal<Record<string, Booking>>({});
    private hydrating = new Set<string>();
    readonly open = signal(false);
    readonly selectedId = signal<string | null>(null);
    readonly error = signal('');
    readonly busy = signal(false);
    readonly enabled = computed(() => !!this.auth.currentUser() && this.auth.userRole() === 'driver' &&
        this.driver.onlineStatus() === 'online' && !this.route().startsWith('/auth') &&
        !this.route().startsWith('/driver/onboarding'));
    readonly requests = computed(() => this.enabled() ? actionableDriverRequests(this.driver.availableJobs()) : []);
    readonly offers = computed(() => this.enabled() ? this.driver.hybridOpportunities() : []);
    readonly count = computed(() => new Set([...this.requests().map(j => j.id), ...this.offers().map(j => j.job_id)]).size);
    readonly ids = computed(() => [...new Set([...this.requests().map(j => j.id), ...this.offers().map(j => j.job_id)])]);
    readonly selectedJob = computed(() => this.requests().find(j => j.id === this.selectedId()) || this.hydrated()[this.selectedId() || ''] || null);
    readonly selectedOffer = computed(() => this.offers().find(j => j.job_id === this.selectedId()) || null);
    readonly mapJobs = computed(() => [...this.requests(), ...this.offers()
        .filter(o => !this.requests().some(j => j.id === o.job_id))
        .map(o => this.hydrated()[o.job_id]).filter((j): j is Booking => !!j)]);
    readonly occupied = computed(() => driverHasCurrentWork(this.driver.activeJob(), this.driver.activeHybridSession(), this.driver.recoverableNegotiations().length));

    constructor() {
        const destroy = inject(DestroyRef);
        this.router.events.pipe(filter(e => e instanceof NavigationEnd), takeUntilDestroyed(destroy))
            .subscribe(() => this.route.set(this.router.url));
        effect(() => {
            const owner = this.auth.currentUser()?.id || null;
            if (owner !== this.owner) {
                this.owner = owner; this.seen.clear(); this.hydrated.set({}); this.open.set(false);
                this.driver.availableJobs.set([]); this.driver.hybridOpportunities.set([]);
                this.driver.activeJob.set(null); this.driver.activeHybridSession.set(null);
                this.driver.recoverableNegotiations.set([]);
            }
            const ids = this.ids();
            if (!ids.length) { this.open.set(false); this.selectedId.set(null); this.error.set(''); return; }
            if (this.open()) this.selectedId.set(liveRequestSelection(ids, this.selectedId()));
            const fresh = ids.find(id => !this.seen.has(id));
            if (fresh) {
                ids.forEach(id => this.seen.add(id));
                if (!this.occupied() && this.driver.isAvailable() && !this.open()) this.show(fresh);
            }
        });
        effect(() => {
            const owner = this.auth.currentUser()?.id;
            for (const offer of this.offers()) {
                if (this.hydrated()[offer.job_id] || this.hydrating.has(offer.job_id)) continue;
                this.hydrating.add(offer.job_id);
                void this.bookings.getBooking(offer.job_id).then(job => {
                    if (owner === this.auth.currentUser()?.id && this.offers().some(o => o.job_id === job.id))
                        this.hydrated.update(all => ({ ...all, [job.id]: job }));
                }).catch(() => {}).finally(() => this.hydrating.delete(offer.job_id));
            }
        });
        // Realtime subscriptions remain in DriverService; this also recovers missed updates on other screens.
        timer(15000, 15000).pipe(takeUntilDestroyed(destroy)).subscribe(() => {
            if (!this.enabled() || this.fetching || this.busy()) return;
            this.fetching = true;
            void this.driver.fetchAvailableJobs().catch(() => {}).finally(() => this.fetching = false);
        });
    }

    title(id: string | null): string {
        const offer = this.offers().find(o => o.job_id === id);
        const job = this.requests().find(j => j.id === id) || this.hydrated()[id || ''];
        return offer?.service_name || job?.service_type?.name ||
            ({ ride: 'Ride', errand: 'Shop', delivery: 'Delivery', 'van-moving': 'Moving' } as Record<string, string>)[job?.service_slug || ''] || 'Request';
    }
    show(id?: string): void {
        if (this.busy() || !this.count()) return;
        this.selectedId.set(liveRequestSelection(this.ids(), id || this.selectedId()));
        this.error.set(''); this.open.set(true);
    }
    close(): void { if (!this.busy()) { this.ids().forEach(id => this.seen.add(id)); this.open.set(false); this.error.set(''); } }
    async accept(): Promise<void> {
        const id = this.selectedId();
        if (!id || this.busy() || this.occupied() || !this.ids().includes(id)) return;
        const offer = this.selectedOffer();
        // Acknowledge attention immediately, before the claim API resolves.
        if (offer) this.driver.acknowledgeNegotiationAlert(offer.session_id);
        this.busy.set(true); this.error.set('');
        try {
            if (offer) {
                await this.driver.claimHybridSession(id);
                this.driver.acknowledgeNegotiationAlert(offer.session_id);
            } else await this.driver.acceptJob(id);
            this.open.set(false);
            await this.router.navigate([offer ? '/driver/hybrid-negotiation' : '/driver/job-details', id]);
        } catch (error) {
            this.error.set(error instanceof Error ? error.message : 'This request is no longer available. Please refresh.');
            void this.driver.fetchAvailableJobs().catch(() => {});
        } finally { this.busy.set(false); }
    }
}

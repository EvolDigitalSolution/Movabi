import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { SupabaseService } from '../supabase/supabase.service';
import {
    Booking,
    DriverStatus,
    Earning,
    Vehicle,
    DriverProfile,
    BookingStatus,
    JobEventType,
    DriverAccount,
    ServiceTypeEnum,
    ErrandDetails,
    ErrandIssuingCardStatus
} from '@shared/models/booking.model';
import { AuthService } from '../auth/auth.service';
import { BookingService } from '../booking/booking.service';
import { WalletService } from '../wallet/wallet.service';
import { ConnectService } from '../stripe/connect.service';
import { JobEventService } from '../job/job-event.service';
import { NotificationService } from '../notification.service';
import { ApiUrlService } from '../api-url.service';
import { VehicleCompatibilityService } from './vehicle-compatibility.service';

@Injectable({
    providedIn: 'root'
})
export class DriverService {
    private supabase = inject(SupabaseService);
    private http = inject(HttpClient);
    private auth = inject(AuthService);
    private bookingService = inject(BookingService);
    private walletService = inject(WalletService);
    private connectService = inject(ConnectService);
    private notificationService = inject(NotificationService);
    private eventService = inject(JobEventService);
    private apiUrlService = inject(ApiUrlService);
    private vehicleCompatibility = inject(VehicleCompatibilityService);

    onlineStatus = signal<DriverStatus>('offline');
    isAvailable = signal<boolean>(true);
    availableJobs = signal<Booking[]>([]);
    activeJob = signal<Booking | null>(null);
    earnings = signal<Earning[]>([]);
    vehicle = signal<Vehicle | null>(null);
    stripeAccount = signal<DriverAccount | null>(null);

    private stripeStatusInFlight = new Map<string, Promise<void>>();
    private lastStripeRefreshAt = new Map<string, number>();

    async toggleOnline(status: DriverStatus) {
        const user = this.auth.currentUser();
        if (!user) return;

        if (status === 'online') {
            if (this.auth.accountStatus() !== 'active') {
                throw new Error(`Your account is ${this.auth.accountStatus()}. You cannot go online.`);
            }

            const profile = await this.fetchProfile();

            if (profile.pricing_plan === 'pro' && profile.subscription_status !== 'active') {
                throw new Error('Active subscription required for Pro Plan to go online');
            }
        }

        const { error } = await this.supabase
            .from('profiles')
            .update({
                is_online: status === 'online',
                last_active_at: new Date().toISOString()
            })
            .eq('id', user.id);

        if (error) throw error;

        this.onlineStatus.set(status);

        if (status === 'online') {
            this.subscribeToJobs();
            await this.fetchStripeAccount();
            await this.fetchAvailableJobs();
        } else {
            this.availableJobs.set([]);
            this.supabase.channel('available-jobs').unsubscribe();
        }
    }

    async toggleAvailability(available: boolean) {
        const user = this.auth.currentUser();
        if (!user) return;

        const { error } = await this.supabase
            .from('profiles')
            .update({
                is_available: available,
                last_active_at: new Date().toISOString()
            })
            .eq('id', user.id);

        if (error) throw error;

        this.isAvailable.set(available);
    }

    private async fetchProfile(): Promise<DriverProfile> {
        const user = this.auth.currentUser();

        if (!user?.id) {
            throw new Error('Not authenticated');
        }

        const { data, error } = await this.supabase
            .from('profiles')
            .select('*')
            .eq('id', user.id)
            .single();

        if (error) throw error;

        return data as DriverProfile;
    }

    private subscribeToJobs() {
        this.supabase.channel('available-jobs').unsubscribe();

        this.supabase
            .channel('available-jobs')
            .on(
                'postgres_changes',
                {
                    event: 'INSERT',
                    schema: 'public',
                    table: 'jobs',
                    filter: 'status=eq.searching'
                },
                async (payload) => {
                    const rawJob = payload.new;

                    if (
                        rawJob['payment_status'] === 'paid' ||
                        rawJob['payment_status'] === 'wallet_funded' ||
                        rawJob['payment_status'] === 'authorized'
                    ) {
                        try {
                            const newJob = await this.bookingService.getBooking(rawJob['id']);

                            const vehicle = this.vehicle() || await this.fetchVehicle();
                            if (!this.vehicleCompatibility.isCompatible(newJob, vehicle)) return;

                            this.availableJobs.update((jobs) => {
                                const exists = jobs.find((job) => job.id === newJob.id);
                                return exists ? jobs : [newJob, ...jobs];
                            });

                            const user = this.auth.currentUser();

                            if (user) {
                                await this.notificationService.notify(
                                    user.id,
                                    'New Request Available',
                                    'A new request is available near you.',
                                    'booking',
                                    { bookingId: newJob.id }
                                );
                            }
                        } catch (error) {
                            console.error('Failed to fetch new job details', error);
                        }
                    }
                }
            )
            .on(
                'postgres_changes',
                {
                    event: 'UPDATE',
                    schema: 'public',
                    table: 'jobs'
                },
                (payload) => {
                    const updatedJob = payload.new;
                    const status = updatedJob['status'];
                    const paymentStatus = updatedJob['payment_status'];

                    if (
                        status !== 'searching' ||
                        !['paid', 'wallet_funded', 'authorized'].includes(paymentStatus)
                    ) {
                        this.availableJobs.update((jobs) => jobs.filter((job) => job.id !== updatedJob['id']));
                    }
                }
            )
            .on(
                'postgres_changes',
                {
                    event: 'DELETE',
                    schema: 'public',
                    table: 'jobs'
                },
                (payload) => {
                    this.availableJobs.update((jobs) => jobs.filter((job) => job.id !== payload.old['id']));
                }
            )
            .subscribe();

        void this.fetchAvailableJobs();
    }

    async fetchVehicle() {
        const user = this.auth.currentUser();
        if (!user) return null;

        const { data, error } = await this.supabase
            .from('vehicles')
            .select('*')
            .eq('user_id', user.id)
            .maybeSingle();

        if (error) {
            console.error('Error fetching vehicle:', error);
            return null;
        }

        this.vehicle.set((data as Vehicle) ?? null);
        return (data as Vehicle) ?? null;
    }

    async fetchAvailableJobs() {
        const { data, error } = await this.supabase
            .from('jobs')
            .select('*, service_type:service_types(*)')
            .eq('status', 'searching')
            .in('payment_status', ['paid', 'wallet_funded', 'authorized'])
            .order('created_at', { ascending: false });

        if (error) throw error;

        const vehicle = this.vehicle() || await this.fetchVehicle();
        const bookings = (data || [])
            .map((job) => this.bookingService.mapJobToBooking(job))
            .filter((job) => this.vehicleCompatibility.isCompatible(job, vehicle));
        this.availableJobs.set(bookings);
    }

    async fetchActiveJob(): Promise<Booking | null> {
        const user = this.auth.currentUser();

        if (!user?.id) {
            this.activeJob.set(null);
            return null;
        }

        const activeStatuses = [
            'assigned',
            'accepted',
            'heading_to_pickup',
            'arrived',
            'arrived_at_store',
            'shopping_in_progress',
            'collected',
            'en_route_to_customer',
            'in_progress',
            'delivered',
            'over_budget_requested'
        ];

        const { data, error } = await this.supabase
            .from('jobs')
            .select('id')
            .eq('driver_id', user.id)
            .in('status', activeStatuses)
            .order('updated_at', { ascending: false })
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (error) {
            console.error('Error fetching active driver job:', error);
            throw error;
        }

        if (!data?.id) {
            this.activeJob.set(null);
            return null;
        }

        const booking = await this.bookingService.getBooking(data.id);
        this.activeJob.set(booking);
        this.availableJobs.update((jobs) => jobs.filter((job) => job.id !== booking.id));

        return booking;
    }

    async acceptJob(bookingId: string) {
        const user = this.auth.currentUser();
        if (!user) throw new Error('Not authenticated');

        if (this.auth.accountStatus() !== 'active') {
            throw new Error(`Your account is ${this.auth.accountStatus()}. You cannot accept requests.`);
        }

        const profile = await this.fetchProfile();

        if (profile.subscription_status !== 'active') {
            throw new Error('Active subscription required to accept requests');
        }

        const job = await this.bookingService.getBooking(bookingId);
        const vehicle = this.vehicle() || await this.fetchVehicle();

        if (!this.vehicleCompatibility.isCompatible(job, vehicle)) {
            throw new Error(
                `This request needs ${this.vehicleCompatibility.getRequiredLabel(job)}. Your saved vehicle is ${this.vehicleCompatibility.getVehicleLabel(vehicle)}.`
            );
        }

        if (job.service_slug === 'errand' && job.errand_funding) {
            const account = await this.fetchStripeAccount();

            const stripeReady =
                account?.stripe_account_id &&
                account?.charges_enabled === true &&
                account?.payouts_enabled === true;

            if (!stripeReady) {
                throw new Error('You must complete Stripe Connect onboarding to accept wallet-funded errands.');
            }
        }

        try {
            await firstValueFrom(
                this.http.post(`${environment.apiUrl}/booking/accept`, {
                    jobId: bookingId,
                    driverId: user.id
                })
            );
        } catch (error: unknown) {
            const err = error as { error?: { message?: string } };
            console.error('Failed to accept job via API', error);
            throw new Error(err.error?.message || 'Failed to accept request. It may have been taken.');
        }

        await this.eventService.logEvent(bookingId, 'driver_accepted', 'Request accepted by driver');

        const fullBooking = await this.bookingService.getBooking(bookingId);

        this.activeJob.set(fullBooking);
        this.availableJobs.update((jobs) => jobs.filter((job) => job.id !== bookingId));

        return fullBooking;
    }

    async getDocumentSignedUrl(path: string): Promise<string | null> {
        try {
            const { data, error } = await this.supabase.storage
                .from('documents')
                .createSignedUrl(path, 60 * 10);

            if (error) {
                console.error('Error creating signed URL:', error);
                return null;
            }

            return data?.signedUrl ?? null;
        } catch (error) {
            console.error('Failed to create signed URL:', error);
            return null;
        }
    }

    async updateJobStatus(bookingId: string, status: BookingStatus) {
        const eventTypeMap: Partial<Record<BookingStatus, JobEventType>> = {
            arrived: 'driver_arrived',
            arrived_at_store: 'driver_arrived',
            shopping_in_progress: 'job_started',
            collected: 'job_started',
            en_route_to_customer: 'job_started',
            delivered: 'job_completed',
            in_progress: 'job_started',
            completed: 'job_completed'
        };

        const eventType = eventTypeMap[status];

        if (eventType) {
            await this.eventService.logEvent(bookingId, eventType, `Driver updated status to ${status}`);
        }

        const updatedBooking = await this.bookingService.updateBookingStatus(
            bookingId,
            status,
            `Status updated by driver to ${status}`
        );

        if (status === 'completed' && updatedBooking.service_slug === 'errand') {
            try {
                await this.walletService.settleErrandFunds(bookingId);
            } catch (error) {
                console.error('Failed to settle errand funds:', error);
            }
        }

        return updatedBooking;
    }

    async fetchEarnings() {
        const user = this.auth.currentUser();
        if (!user) return;

        const { data, error } = await this.supabase
            .from('driver_earnings')
            .select('*')
            .eq('driver_id', user.id)
            .order('created_at', { ascending: false });

        if (error) throw error;

        this.earnings.set(data || []);
    }

    async completeJob(jobId: string) {
        const job = await this.bookingService.getBooking(jobId);

        if (job.service_slug === 'errand') {
            const funding = await this.bookingService.getErrandFunding(jobId);
            const details = (await this.bookingService.getBookingDetails(
                jobId,
                ServiceTypeEnum.ERRAND
            )) as ErrandDetails;

            if (funding?.over_budget_status === 'requested') {
                throw new Error('Please wait for the customer to approve or reject your over-budget request before completing.');
            }

            if (details?.actual_spending === undefined || details?.actual_spending === null) {
                throw new Error('Please record the actual amount spent on items before completing.');
            }

            if (details?.actual_spending > 0 && !details?.receipt_url) {
                throw new Error('Please upload a receipt for the items purchased before completing.');
            }
        }

        const url = this.apiUrlService.getApiUrl('/api/logistics/complete');

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId })
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || 'Failed to complete request');
        }

        const result = await response.json();

        this.activeJob.set(null);
        return result.data;
    }

    async handoffJob(jobId: string, reason: string): Promise<{ success: boolean; mode: 'requeued' | 'review'; message: string }> {
        const user = this.auth.currentUser();
        if (!user) throw new Error('Not authenticated');

        const response = await firstValueFrom(
            this.http.post<{ success: boolean; mode: 'requeued' | 'review'; message: string }>(
                this.apiUrlService.getApiUrl('/api/booking/driver-unable'),
                {
                    jobId,
                    driverId: user.id,
                    reason
                }
            )
        );

        this.activeJob.set(null);
        this.availableJobs.update((jobs) => jobs.filter((job) => job.id !== jobId));
        await this.eventService.logEvent(jobId, 'driver_handoff_requested' as JobEventType, reason);

        return response;
    }

    async recordErrandSpending(jobId: string, amount: number, notes?: string) {
        const [job, details, funding] = await Promise.all([
            this.bookingService.getBooking(jobId),
            this.bookingService.getBookingDetails(jobId, ServiceTypeEnum.ERRAND) as Promise<ErrandDetails>,
            this.bookingService.getErrandFunding(jobId)
        ]);
        const user = this.auth.currentUser();
        const initialBudget = Math.max(0, Number(details?.estimated_budget || 0));
        const approvedExtra = funding?.over_budget_status === 'approved'
            ? Math.max(0, Number(funding.requested_over_budget_amount ?? funding.over_budget_amount ?? 0))
            : 0;
        const approvedBudget = Number((initialBudget + approvedExtra).toFixed(2));
        const normalizedAmount = Number(Number(amount).toFixed(2));

        if (!user || job.driver_id !== user.id) {
            throw new Error('Only the assigned driver can record spending for this request.');
        }
        if (!Number.isFinite(normalizedAmount) || normalizedAmount < 0) {
            throw new Error('Enter a valid spending amount.');
        }
        if (normalizedAmount > approvedBudget) {
            throw new Error(
                `Spending cannot exceed the approved £${approvedBudget.toFixed(2)} item budget. Request extra budget first.`
            );
        }

        const payload: Record<string, unknown> = {
            actual_spending: normalizedAmount,
            spending_notes: notes,
            updated_at: new Date().toISOString()
        };

        let { data, error } = await this.supabase
            .from('errand_details')
            .update(payload)
            .eq('job_id', jobId)
            .select('*')
            .maybeSingle();

        if (error?.code === '42703') {
            const { data: fallbackData, error: fallbackError } = await this.supabase
                .from('errand_details')
                .update({ actual_spending: normalizedAmount })
                .eq('job_id', jobId)
                .select('*')
                .maybeSingle();

            data = fallbackData;
            error = fallbackError;
        }

        if (error) throw error;
        if (!data) {
            throw new Error('Errand details were not updated. Please refresh and try again.');
        }

        await this.eventService.logEvent(
            jobId,
            'errand_spending_recorded',
            `Driver recorded spending of £${amount.toFixed(2)}`,
            { amount: normalizedAmount, notes }
        );

        return data;
    }

    async updateVehicle(vehicleData: Partial<Vehicle>) {
        const user = this.auth.currentUser();
        if (!user) throw new Error('Not authenticated');

        const payload = {
            user_id: user.id,
            make: String(vehicleData.make ?? '').trim(),
            model: String(vehicleData.model ?? '').trim(),
            year: Number(vehicleData.year),
            license_plate: String(vehicleData.license_plate ?? '').trim(),
            color: String(vehicleData.color ?? '').trim(),
            type: this.normalizeVehicleType((vehicleData as any).type),
            capacity: String((vehicleData as any).capacity || this.defaultCapacityForType((vehicleData as any).type)).trim()
        };

        const requiresPlate = payload.type !== 'motorcycle';

        if (!payload.make || !payload.model || !payload.color || (requiresPlate && !payload.license_plate)) {
            throw new Error('Missing vehicle fields');
        }

        if (!Number.isInteger(payload.year) || payload.year < 1900) {
            throw new Error('Invalid vehicle year');
        }

        let { data, error } = await this.supabase
            .from('vehicles')
            .upsert(payload, { onConflict: 'user_id' })
            .select()
            .single();

        if (error && this.isMissingColumnError(error, 'color')) {
            const legacyPayload = { ...payload } as Partial<typeof payload>;
            delete legacyPayload.color;
            const retry = await this.supabase
                .from('vehicles')
                .upsert(legacyPayload, { onConflict: 'user_id' })
                .select()
                .single();

            data = retry.data;
            error = retry.error;
        }

        if (error) {
            console.error('[DriverService] updateVehicle failed:', error);
            throw error;
        }

        this.vehicle.set(data as Vehicle);
    }

    private isMissingColumnError(error: unknown, column: string): boolean {
        const maybeError = error as { code?: string; message?: string };
        return maybeError?.code === '42703' && String(maybeError?.message || '').includes(column);
    }

    private normalizeVehicleType(value: unknown): 'car' | 'van' | 'motorcycle' {
        const raw = String(value || '').toLowerCase();
        if (raw.includes('van')) return 'van';
        if (raw.includes('bike') || raw.includes('motorcycle') || raw.includes('scooter')) return 'motorcycle';
        return 'car';
    }

    private defaultCapacityForType(value: unknown): string {
        const type = this.normalizeVehicleType(value);
        if (type === 'van') {
            const raw = String(value || '').toLowerCase();
            return raw.includes('large') || raw.includes('luton') ? 'large_van' : 'small_van';
        }
        if (type === 'motorcycle') return 'bike';
        return 'standard';
    }

    async uploadDocument(file: File, type: string) {
        const user = this.auth.currentUser();
        if (!user) return;

        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const path = `drivers/${user.id}/${type}_${Date.now()}_${safeName}`;

        const { data, error } = await this.supabase.storage
            .from('documents')
            .upload(path, file);

        if (error) throw error;

        return data.path;
    }

    async uploadErrandReceipt(jobId: string, file: File) {
        const user = this.auth.currentUser();
        if (!user) throw new Error('Not authenticated');

        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const path = `receipts/${jobId}/${Date.now()}_${safeName}`;

        const { data, error } = await this.supabase.storage
            .from('documents')
            .upload(path, file);

        if (error) throw error;

        const { data: updatedDetails, error: updateError } = await this.supabase
            .from('errand_details')
            .update({ receipt_url: data.path, updated_at: new Date().toISOString() })
            .eq('job_id', jobId)
            .select('*')
            .maybeSingle();

        if (updateError) throw updateError;
        if (!updatedDetails) {
            throw new Error('Receipt uploaded, but the errand details row was not updated.');
        }

        await this.eventService.logEvent(jobId, 'errand_receipt_uploaded', 'Driver uploaded a receipt', {
            path: data.path
        });

        return updatedDetails;
    }

    async requestOverBudget(jobId: string, amount: number, reason: string) {
        await this.walletService.requestErrandOverBudget(jobId, amount, reason);
        await this.eventService.logEvent(jobId, 'over_budget_requested', `Driver requested £${amount} extra for: ${reason}`);
    }

    async getErrandIssuingCardStatus(jobId: string): Promise<ErrandIssuingCardStatus | null> {
        const token = await this.getAccessToken();
        if (!token) return null;

        return firstValueFrom(
            this.http.get<ErrandIssuingCardStatus>(
                this.apiUrlService.getApiUrl(`/api/issuing/errand-card/${jobId}/status`),
                { headers: { Authorization: `Bearer ${token}` } }
            )
        );
    }

    async activateErrandIssuingCard(jobId: string): Promise<ErrandIssuingCardStatus> {
        const token = await this.getAccessToken();
        if (!token) throw new Error('Not authenticated');

        return firstValueFrom(
            this.http.post<ErrandIssuingCardStatus>(
                this.apiUrlService.getApiUrl('/api/issuing/errand-card/activate'),
                { jobId },
                { headers: { Authorization: `Bearer ${token}` } }
            )
        );
    }

    async ensureMovabiPayVirtualCard(): Promise<ErrandIssuingCardStatus | null> {
        const token = await this.getAccessToken();
        if (!token) return null;

        return firstValueFrom(
            this.http.post<ErrandIssuingCardStatus>(
                this.apiUrlService.getApiUrl('/api/issuing/driver-card/ensure'),
                {},
                { headers: { Authorization: `Bearer ${token}` } }
            )
        );
    }

    async createIssuingCardDetailsSession(cardId: string, nonce: string): Promise<{ ephemeralKeySecret: string }> {
        const token = await this.getAccessToken();
        if (!token) throw new Error('Not authenticated');

        return firstValueFrom(
            this.http.post<{ ephemeralKeySecret: string }>(
                this.apiUrlService.getApiUrl('/api/issuing/card-details/ephemeral-key'),
                { cardId, nonce },
                { headers: { Authorization: `Bearer ${token}` } }
            )
        );
    }

    private async getAccessToken(): Promise<string | null> {
        const { data } = await this.supabase.auth.getSession();
        return data.session?.access_token || null;
    }

    async fetchStripeAccount() {
        const user = this.auth.currentUser();
        if (!user) return null;

        const { data: profile, error: profileError } = await this.supabase
            .from('profiles')
            .select('id, stripe_account_id, stripe_connect_status')
            .eq('id', user.id)
            .maybeSingle();

        if (profileError) {
            console.error('Error fetching profile Stripe account:', profileError);
            return null;
        }

        const profileAccountId = (profile as any)?.stripe_account_id;

        if (!profileAccountId) {
            this.stripeAccount.set(null);
            return null;
        }

        try {
            const status = await this.connectService.refreshAccountStatus(profileAccountId, user.id);

            const account = {
                user_id: user.id,
                stripe_account_id: status.stripe_account_id || profileAccountId,
                onboarding_complete: status.onboarding_complete,
                payouts_enabled: status.payouts_enabled === true,
                charges_enabled: status.charges_enabled === true,
                onboarding_status: status.status
            } as any;

            this.stripeAccount.set(account);
            return account;
        } catch (error) {
            console.error('Error fetching Stripe account status:', error);

            const fallback = {
                user_id: user.id,
                stripe_account_id: profileAccountId,
                onboarding_complete: false,
                payouts_enabled: false,
                charges_enabled: false,
                onboarding_status: (profile as any)?.stripe_connect_status || 'pending'
            } as any;

            this.stripeAccount.set(fallback);
            return fallback;
        }
    }

    async refreshStripeStatus(accountId: string, force = false) {
        const user = this.auth.currentUser();

        if (!accountId || !user) return;

        const now = Date.now();
        const lastRun = this.lastStripeRefreshAt.get(accountId) ?? 0;

        if (!force && now - lastRun < 15000) return;

        const existing = this.stripeStatusInFlight.get(accountId);
        if (existing) return existing;

        const promise = (async () => {
            try {
                this.lastStripeRefreshAt.set(accountId, Date.now());

                const status = await this.connectService.refreshAccountStatus(accountId, user.id);

                const account = {
                    user_id: user.id,
                    stripe_account_id: status.stripe_account_id || accountId,
                    onboarding_complete: status.onboarding_complete,
                    payouts_enabled: status.payouts_enabled === true,
                    charges_enabled: status.charges_enabled === true,
                    onboarding_status: status.status
                } as any;

                this.stripeAccount.set(account);
            } catch (error) {
                console.error('Failed to refresh stripe status', error);
            } finally {
                this.stripeStatusInFlight.delete(accountId);
            }
        })();

        this.stripeStatusInFlight.set(accountId, promise);
        return promise;
    }

    async setupStripeConnect() {
        const user = this.auth.currentUser();
        if (!user) throw new Error('Not authenticated');

        await this.fetchStripeAccount();

        let accountId = this.stripeAccount()?.stripe_account_id;

        if (!accountId) {
            const { data: profile } = await this.supabase
                .from('profiles')
                .select('tenant_id')
                .eq('id', user.id)
                .maybeSingle();

            const { stripe_account_id } = await this.connectService.createAccount(
                user.id,
                user.email || '',
                (profile as any)?.tenant_id || null
            );

            accountId = stripe_account_id;
            await this.fetchStripeAccount();
        }

        const returnUrl = `${window.location.origin}/driver?stripe=success`;
        const refreshUrl = `${window.location.origin}/driver?stripe=refresh`;

        const { url } = await this.connectService.getOnboardingLink(
            accountId,
            returnUrl,
            refreshUrl
        );

        return url;
    }
}

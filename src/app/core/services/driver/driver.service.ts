import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { SupabaseService } from '../supabase/supabase.service';
import { Booking, DriverStatus, Earning, Vehicle, DriverProfile, BookingStatus, JobEventType, DriverAccount, ServiceTypeEnum, ErrandDetails } from '@shared/models/booking.model';
import { AuthService } from '../auth/auth.service';
import { BookingService } from '../booking/booking.service';
import { WalletService } from '../wallet/wallet.service';
import { ConnectService } from '../stripe/connect.service';
import { JobEventService } from '../job/job-event.service';
import { NotificationService } from '../notification.service';
import { ApiUrlService } from '../api-url.service';

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

    onlineStatus = signal<DriverStatus>('offline');
    isAvailable = signal<boolean>(true);
    availableJobs = signal<Booking[]>([]);
    activeJob = signal<Booking | null>(null);
    earnings = signal<Earning[]>([]);
    vehicle = signal<Vehicle | null>(null);
    stripeAccount = signal<DriverAccount | null>(null);

    // Prevent repeated Stripe status calls
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
            .update({ status })
            .eq('id', user.id);

        if (error) throw error;
        this.onlineStatus.set(status);

        if (status === 'online') {
            this.subscribeToJobs();
            await this.fetchStripeAccount();
        } else {
            this.supabase.channel('available-jobs').unsubscribe();
        }
    }

    async toggleAvailability(available: boolean) {
        const user = this.auth.currentUser();
        if (!user) return;

        const { error } = await this.supabase
            .from('profiles')
            .update({ is_available: available })
            .eq('id', user.id);

        if (error) throw error;
        this.isAvailable.set(available);
    }

    private async fetchProfile(): Promise<DriverProfile> {
        const user = this.auth.currentUser();
        const { data, error } = await this.supabase
            .from('profiles')
            .select('*')
            .eq('id', user?.id)
            .single();
        if (error) throw error;
        return data as DriverProfile;
    }

    private subscribeToJobs() {
        this.supabase
            .channel('available-jobs')
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'jobs',
                filter: 'status=eq.searching'
            }, async payload => {
                const rawJob = payload.new;
                if (rawJob['payment_status'] === 'paid' || rawJob['payment_status'] === 'wallet_funded') {
                    try {
                        const newJob = await this.bookingService.getBooking(rawJob['id']);
                        this.availableJobs.update(jobs => {
                            const exists = jobs.find(j => j.id === newJob.id);
                            return exists ? jobs : [newJob, ...jobs];
                        });

                        const user = this.auth.currentUser();
                        if (user) {
                            await this.notificationService.notify(
                                user.id,
                                'New Job Available',
                                `A new request is available near you.`,
                                'booking',
                                { bookingId: newJob.id }
                            );
                        }
                    } catch (e) {
                        console.error('Failed to fetch new job details', e);
                    }
                }
            })
            .on('postgres_changes', {
                event: 'UPDATE',
                schema: 'public',
                table: 'jobs'
            }, payload => {
                const updatedJob = payload.new;
                if (updatedJob['status'] !== 'searching' || updatedJob['payment_status'] !== 'paid') {
                    this.availableJobs.update(jobs => jobs.filter(j => j.id !== updatedJob['id']));
                }
            })
            .on('postgres_changes', {
                event: 'DELETE',
                schema: 'public',
                table: 'jobs'
            }, payload => {
                this.availableJobs.update(jobs => jobs.filter(j => j.id !== payload.old['id']));
            })
            .subscribe();

        this.fetchAvailableJobs();
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
            .in('payment_status', ['paid', 'wallet_funded'])
            .order('created_at', { ascending: false });

        if (error) throw error;
        const bookings = (data || []).map(job => this.bookingService.mapJobToBooking(job));
        this.availableJobs.set(bookings);
    }

    async acceptJob(bookingId: string) {
        const user = this.auth.currentUser();
        if (!user) throw new Error('Not authenticated');

        if (this.auth.accountStatus() !== 'active') {
            throw new Error(`Your account is ${this.auth.accountStatus()}. You cannot accept jobs.`);
        }

        const profile = await this.fetchProfile();
        if (profile.subscription_status !== 'active') {
            throw new Error('Active subscription required to accept jobs');
        }

        const job = await this.bookingService.getBooking(bookingId);
        if (job.service_slug === 'errand' && job.errand_funding) {
            if (this.auth.stripeConnectStatus() !== 'enabled') {
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
            throw new Error(err.error?.message || 'Failed to accept job. It may have been taken.');
        }

        await this.eventService.logEvent(bookingId, 'driver_accepted', 'Job accepted by driver');

        const fullBooking = await this.bookingService.getBooking(bookingId);

        this.activeJob.set(fullBooking);
        this.availableJobs.update(jobs => jobs.filter(j => j.id !== bookingId));
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
            'arrived': 'driver_arrived',
            'arrived_at_store': 'driver_arrived',
            'shopping_in_progress': 'job_started',
            'collected': 'job_started',
            'en_route_to_customer': 'job_started',
            'delivered': 'job_completed',
            'in_progress': 'job_started',
            'completed': 'job_completed'
        };

        const eventType = eventTypeMap[status];
        if (eventType) {
            await this.eventService.logEvent(bookingId, eventType, `Driver updated status to ${status}`);
        }

        const updatedBooking = await this.bookingService.updateBookingStatus(bookingId, status, `Status updated by driver to ${status}`);

        if (status === 'completed' && updatedBooking.service_slug === 'errand') {
            try {
                await this.walletService.settleErrandFunds(bookingId);
            } catch (e) {
                console.error('Failed to settle errand funds:', e);
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
            const details = await this.bookingService.getBookingDetails(jobId, ServiceTypeEnum.ERRAND) as ErrandDetails;

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
            throw new Error(err.error || 'Failed to complete job');
        }

        const result = await response.json();
        this.activeJob.set(null);
        return result.data;
    }

    async recordErrandSpending(jobId: string, amount: number, notes?: string) {
        const { error } = await this.supabase
            .from('errand_details')
            .update({
                actual_spending: amount,
                spending_notes: notes
            })
            .eq('job_id', jobId);

        if (error) throw error;

        await this.eventService.logEvent(jobId, 'errand_spending_recorded', `Driver recorded spending of £${amount.toFixed(2)}`, { amount, notes });
    }

    async updateVehicle(vehicleData: Partial<Vehicle>) {
        const user = this.auth.currentUser();
        if (!user) throw new Error('Not authenticated');

        const payload = {
            user_id: user.id,
            make: String(vehicleData.make ?? '').trim(),
            model: String(vehicleData.model ?? '').trim(),
            year: Number(vehicleData.year),
            license_plate: String(vehicleData.license_plate ?? '').trim()
        };

        if (!payload.make || !payload.model || !payload.license_plate) {
            throw new Error('Missing vehicle fields');
        }

        if (!Number.isInteger(payload.year) || payload.year < 1900) {
            throw new Error('Invalid vehicle year');
        }

        const { data, error } = await this.supabase
            .from('vehicles')
            .upsert(payload, { onConflict: 'user_id' })
            .select()
            .single();

        if (error) {
            console.error('[DriverService] updateVehicle failed:', error);
            throw error;
        }

        this.vehicle.set(data as Vehicle);
    }

    async uploadDocument(file: File, type: string) {
        const user = this.auth.currentUser();
        if (!user) return;

        const path = `drivers/${user.id}/${type}_${Date.now()}`;
        const { data, error } = await this.supabase.storage
            .from('documents')
            .upload(path, file);

        if (error) throw error;
        return data.path;
    }

    async uploadErrandReceipt(jobId: string, file: File) {
        const user = this.auth.currentUser();
        if (!user) throw new Error('Not authenticated');

        const path = `receipts/${jobId}/${Date.now()}_${file.name}`;
        const { data, error } = await this.supabase.storage
            .from('documents')
            .upload(path, file);

        if (error) throw error;

        const { error: updateError } = await this.supabase
            .from('errand_details')
            .update({ receipt_url: data.path })
            .eq('job_id', jobId);

        if (updateError) throw updateError;

        await this.eventService.logEvent(jobId, 'errand_receipt_uploaded', 'Driver uploaded a receipt', { path: data.path });

        return data.path;
    }

    async requestOverBudget(jobId: string, amount: number, reason: string) {
        await this.walletService.requestErrandOverBudget(jobId, amount, reason);
        await this.eventService.logEvent(jobId, 'over_budget_requested', `Driver requested £${amount} extra for: ${reason}`);
    }

    async fetchStripeAccount() {
        const user = this.auth.currentUser();
        if (!user) return null;

        const { data, error } = await this.supabase
            .from('driver_accounts')
            .select('*')
            .eq('user_id', user.id)
            .maybeSingle();

        if (error) {
            console.error('Error fetching stripe account:', error);
            return null;
        }

        this.stripeAccount.set((data as DriverAccount) ?? null);
        return (data as DriverAccount) ?? null;
    }

    async refreshStripeStatus(accountId: string, force = false) {
        if (!accountId) return;

        const now = Date.now();
        const lastRun = this.lastStripeRefreshAt.get(accountId) ?? 0;

        if (!force && now - lastRun < 15000) {
            return;
        }

        const existing = this.stripeStatusInFlight.get(accountId);
        if (existing) {
            return existing;
        }

        const promise = (async () => {
            try {
                this.lastStripeRefreshAt.set(accountId, Date.now());

                const status = await this.connectService.getAccountStatus(accountId);

                // ✅ FIX: use correct fields from your API
                const updatePayload = {
                    onboarding_complete: status.onboarding_complete,
                    payouts_enabled: status.payouts_enabled,
                    charges_enabled: status.charges_enabled,
                    onboarding_status: status.status
                };

                const { error } = await this.supabase
                    .from('driver_accounts')
                    .update(updatePayload)
                    .eq('stripe_account_id', accountId);

                if (error) throw error;

                await this.fetchStripeAccount();
            } catch (e) {
                console.error('Failed to refresh stripe status', e);
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

        let accountId = this.stripeAccount()?.stripe_account_id;

        if (!accountId) {
            const { stripe_account_id } = await this.connectService.createAccount(
                user.id,
                user.email!,
                this.auth.tenantId()!
            );
            accountId = stripe_account_id;
            await this.fetchStripeAccount();
        }

        const returnUrl = `${window.location.origin}/driver?stripe=success`;
        const refreshUrl = `${window.location.origin}/driver?stripe=refresh`;

        const { url } = await this.connectService.getOnboardingLink(accountId, returnUrl, refreshUrl);
        return url;
    }
}
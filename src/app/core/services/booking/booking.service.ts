import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { SupabaseService } from '../supabase/supabase.service';
import { RealtimeChannel } from '@supabase/supabase-js';
import {
    Booking,
    ServiceType,
    ServiceTypeEnum,
    BookingStatus,
    ErrandFunding
} from '@shared/models/booking.model';
import { AuthService } from '../auth/auth.service';
import { AppConfigService } from '../config/app-config.service';
import { BookingStatusManager } from './booking-status.manager';
import { NotificationService } from '../notification.service';
import { JobEventService } from '../job/job-event.service';
import { EmailService } from '../notification/email.service';
import { ApiUrlService } from '../api-url.service';

@Injectable({
    providedIn: 'root'
})
export class BookingService {
    private supabase = inject(SupabaseService);
    private http = inject(HttpClient);
    private auth = inject(AuthService);
    private config = inject(AppConfigService);
    private statusManager = inject(BookingStatusManager);
    private notificationService = inject(NotificationService);
    private eventService = inject(JobEventService);
    private emailService = inject(EmailService);
    private apiUrlService = inject(ApiUrlService);

    activeBooking = signal<Booking | null>(null);
    bookingHistory = signal<Booking[]>([]);

    async getServiceTypes(): Promise<ServiceType[]> {
        const { data, error } = await this.supabase
            .from('service_types')
            .select('*')
            .eq('is_active', true);

        if (error) throw error;
        return data || [];
    }

    async createBooking(
        bookingData: Partial<Booking>,
        details: Record<string, unknown>,
        serviceSlug: ServiceTypeEnum
    ) {
        const user = this.auth.currentUser();
        if (!user) throw new Error('Not authenticated');

        if (this.auth.accountStatus() !== 'active') {
            throw new Error(`Your account is ${this.auth.accountStatus()}. You cannot create new bookings.`);
        }

        const normalizedDetails = this.normalizeDetails(serviceSlug, details);

        this.validateDetails(serviceSlug, {
            ...details,
            ...normalizedDetails
        });

        const pricing = await this.calculateRegionalPrice(bookingData, serviceSlug);

        const totalPrice = Number(
            pricing?.totalPrice ??
            pricing?.basePrice ??
            bookingData.total_price ??
            bookingData.price ??
            0
        );

        const countryCode = String(pricing?.countryCode || this.getCountryCode() || 'GB').toUpperCase();
        const currencyCode = String(pricing?.currencyCode || this.getCurrencyCode() || this.currencyFromCountry(countryCode)).toUpperCase();
        const currencySymbol = pricing?.currencySymbol || this.getCurrencySymbol(currencyCode);

        const { data: job, error: bError } = await this.supabase
            .from('jobs')
            .insert({
                customer_id: user.id,
                service_type_id: bookingData.service_type_id,
                status: 'requested',
                payment_status: 'pending',

                pickup_address: bookingData.pickup_address,
                pickup_lat: bookingData.pickup_lat,
                pickup_lng: bookingData.pickup_lng,
                dropoff_address: bookingData.dropoff_address,
                dropoff_lat: bookingData.dropoff_lat,
                dropoff_lng: bookingData.dropoff_lng,

                price: totalPrice,
                total_price: totalPrice,

                country_code: countryCode,
                currency_code: currencyCode,
                currency_symbol: currencySymbol,

                regional_pricing_rule_id: pricing?.regionalPricingRuleId || null,
                pricing_plan_used: pricing?.pricingPlanUsed || (bookingData as any).pricing_plan || 'starter',
                base_fare_used: Number(pricing?.baseFareUsed || 0),
                price_per_km_used: Number(pricing?.pricePerKmUsed || 0),
                commission_rate_used: Number(pricing?.commissionRateUsed || 15),
                platform_fee: Number(pricing?.platformFee || 0),
                driver_payout: Number(pricing?.driverPayout || 0),
                tax_amount: Number(pricing?.taxAmount || 0),
                surge_multiplier: Number(pricing?.surgeMultiplier || 1),

                scheduled_time: bookingData.scheduled_time || new Date().toISOString(),
                tenant_id: this.auth.tenantId(),
                metadata: {
                    ...(bookingData.metadata || {}),
                    pricing_source: pricing?.pricingSource || pricing?.source || 'unknown',
                    distance_km: this.getDistanceKm(bookingData)
                }
            })
            .select()
            .single();

        if (bError) throw bError;

        const detailsTable = this.getDetailsTable(serviceSlug);
        let detailsInsert: Record<string, unknown>;

        switch (serviceSlug) {
            case ServiceTypeEnum.ERRAND:
                detailsInsert = {
                    job_id: job.id,
                    items_list: normalizedDetails['items_list'] ?? [],
                    estimated_budget: normalizedDetails['estimated_budget'] ?? 0,
                    store_name: normalizedDetails['store_name'] ?? null,
                    store_address: normalizedDetails['store_address'] ?? null,
                    delivery_instructions: normalizedDetails['delivery_instructions'] ?? null,
                    customer_phone: normalizedDetails['customer_phone'] ?? null,
                    recipient_phone: normalizedDetails['recipient_phone'] ?? null,
                    recipient_name: normalizedDetails['recipient_name'] ?? null,
                    substitution_rule: normalizedDetails['substitution_rule'] ?? null
                };
                break;

            default:
                detailsInsert = {
                    ...normalizedDetails,
                    job_id: job.id
                };
                break;
        }

        const { error: dError } = await this.supabase
            .from(detailsTable)
            .insert(detailsInsert);

        if (dError) throw dError;

        await this.logStatusHistory(job.id, 'requested', 'Job created, awaiting payment');
        await this.eventService.logEvent(job.id, 'job_created', 'Job initialized in requested state');

        const booking = this.mapJobToBooking(job);
        this.activeBooking.set(booking);
        return booking;
    }

    private async calculateRegionalPrice(
        bookingData: Partial<Booking>,
        serviceSlug: ServiceTypeEnum
    ): Promise<any> {
        const pickupLat = Number(bookingData.pickup_lat || 0);
        const pickupLng = Number(bookingData.pickup_lng || 0);
        const distanceKm = this.getDistanceKm(bookingData);

        const countryCode = String((bookingData as any).country_code || this.getCountryCode() || 'GB').toUpperCase();
        const currencyCode = String((bookingData as any).currency_code || this.getCurrencyCode() || this.currencyFromCountry(countryCode)).toUpperCase();

        const url = this.apiUrlService.getApiUrl('/api/payment/calculate-price');

        return await firstValueFrom(
            this.http.post<any>(url, {
                lat: pickupLat,
                lng: pickupLng,
                basePrice: bookingData.total_price || bookingData.price || 0,
                distanceKm,
                serviceSlug,
                serviceType: serviceSlug,
                countryCode,
                currencyCode,
                pricingPlan: (bookingData as any).pricing_plan || 'starter'
            })
        );
    }

    private getDistanceKm(bookingData: Partial<Booking>): number {
        const distance = Number(
            (bookingData as any).distance_km ||
            (bookingData as any).estimated_distance_km ||
            (bookingData as any).distance ||
            0
        );

        return Number.isFinite(distance) ? distance : 0;
    }

    private getCountryCode(): string {
        return String(
            this.auth.profileService.profile()?.country_code ||
            this.config.currentCountry()?.code ||
            'GB'
        ).toUpperCase();
    }

    private getCurrencyCode(): string {
        return String(
            this.auth.profileService.profile()?.currency_code ||
            this.config.currencyCode ||
            this.currencyFromCountry(this.getCountryCode()) ||
            'GBP'
        ).toUpperCase();
    }

    private getCurrencySymbol(currencyCode?: string | null): string {
        const currentCountry = this.config.currentCountry();

        if (currentCountry?.currencySymbol && currentCountry?.currency === currencyCode) {
            return currentCountry.currencySymbol;
        }

        return this.symbolFromCurrency(currencyCode || this.getCurrencyCode());
    }

    private currencyFromCountry(countryCode?: string | null): string {
        const map: Record<string, string> = {
            GB: 'GBP',
            US: 'USD',
            NG: 'NGN',
            AE: 'AED',
            CA: 'CAD',
            AU: 'AUD',
            IE: 'EUR',
            FR: 'EUR',
            DE: 'EUR',
            ES: 'EUR',
            IT: 'EUR',
            NL: 'EUR',
            BE: 'EUR',
            PT: 'EUR'
        };

        return map[String(countryCode || 'GB').toUpperCase()] || 'GBP';
    }

    private symbolFromCurrency(currencyCode?: string | null): string {
        const map: Record<string, string> = {
            GBP: '£',
            USD: '$',
            EUR: '€',
            NGN: '₦',
            AED: 'د.إ',
            CAD: '$',
            AUD: '$'
        };

        return map[String(currencyCode || 'GBP').toUpperCase()] || '£';
    }

    private isShoppingErrandMode(mode: unknown): boolean {
        return mode === 'quick_buy' || mode === 'shop_deliver';
    }

    private normalizeErrandDetails(details: Record<string, unknown>): Record<string, unknown> {
        const mode = String(details['errand_mode'] || 'collect_deliver');

        const normalized: Record<string, unknown> = {
            items_list: [],
            estimated_budget: 0,
            store_name: details['store_name'] ?? null,
            store_address: details['store_address'] ?? null,
            delivery_instructions: details['delivery_instructions'] ?? null,
            customer_phone: details['customer_phone'] ?? null,
            recipient_phone: details['recipient_phone'] ?? null,
            recipient_name: details['recipient_name'] ?? null,
            substitution_rule: details['substitution_rule'] ?? 'contact_me'
        };

        if (this.isShoppingErrandMode(mode)) {
            const items = Array.isArray(details['items_list'])
                ? details['items_list'].map(item => String(item).trim()).filter(Boolean)
                : [];

            const estimatedBudget = Number(details['estimated_budget'] || 0);

            normalized['items_list'] = items;
            normalized['estimated_budget'] = Number.isFinite(estimatedBudget) ? estimatedBudget : 0;
        }

        return normalized;
    }

    private normalizeDetails(
        serviceCode: ServiceTypeEnum,
        details: Record<string, unknown>
    ): Record<string, unknown> {
        switch (serviceCode) {
            case ServiceTypeEnum.ERRAND:
                return this.normalizeErrandDetails(details);
            default:
                return details;
        }
    }

    private validateDetails(serviceCode: ServiceTypeEnum, details: Record<string, unknown>) {
        switch (serviceCode) {
            case ServiceTypeEnum.RIDE:
                if (!details['passenger_count']) {
                    throw new Error('Passenger count is required for rides');
                }
                break;

            case ServiceTypeEnum.ERRAND: {
                const mode = String(details['errand_mode'] || 'collect_deliver');
                const isShoppingMode = this.isShoppingErrandMode(mode);

                if (isShoppingMode) {
                    const items = Array.isArray(details['items_list']) ? details['items_list'] : [];
                    const estimatedBudget = Number(details['estimated_budget'] || 0);

                    if (items.length === 0) {
                        throw new Error('Items list is required for shopping errands');
                    }

                    if (!Number.isFinite(estimatedBudget) || estimatedBudget <= 0) {
                        throw new Error('Estimated budget is required for shopping errands');
                    }
                }

                break;
            }

            case ServiceTypeEnum.DELIVERY:
                if (!details['recipient_name'] || !details['recipient_phone']) {
                    throw new Error('Recipient name and phone are required for deliveries');
                }
                break;

            case ServiceTypeEnum.VAN:
                if (details['helper_count'] === undefined) {
                    throw new Error('Helper count is required for van service');
                }
                break;
        }
    }

    private getDetailsTable(serviceCode: ServiceTypeEnum): string {
        switch (serviceCode) {
            case ServiceTypeEnum.RIDE:
                return 'ride_details';
            case ServiceTypeEnum.ERRAND:
                return 'errand_details';
            case ServiceTypeEnum.DELIVERY:
                return 'delivery_details';
            case ServiceTypeEnum.VAN:
                return 'van_details';
            default:
                throw new Error(`Unsupported service type: ${serviceCode}`);
        }
    }

    async updateBookingStatus(
        bookingId: string,
        nextStatus: BookingStatus,
        notes?: string,
        additionalData: Partial<Booking> = {},
        currentStatus?: BookingStatus,
        isAdmin = false
    ) {
        let statusToValidate = currentStatus;

        if (!statusToValidate) {
            const active = this.activeBooking();
            if (active && active.id === bookingId) {
                statusToValidate = active.status;
            } else {
                const { data, error } = await this.supabase
                    .from('jobs')
                    .select('status')
                    .eq('id', bookingId)
                    .single();

                if (error) throw error;
                statusToValidate = data.status as BookingStatus;
            }
        }

        if (!statusToValidate || !this.statusManager.canTransition(statusToValidate, nextStatus, isAdmin)) {
            throw new Error(`Invalid status transition from ${statusToValidate || 'unknown'} to ${nextStatus}`);
        }

        const updatePayload: any = { status: nextStatus };

        if (additionalData.driver_id) updatePayload.driver_id = additionalData.driver_id;

        if (additionalData.total_price !== undefined && additionalData.total_price !== null) {
            updatePayload.price = Number(additionalData.total_price) || 0;
            updatePayload.total_price = Number(additionalData.total_price) || 0;
        }

        const query = this.supabase
            .from('jobs')
            .update(updatePayload)
            .eq('id', bookingId);

        if (statusToValidate && !isAdmin) {
            query.eq('status', statusToValidate);
        }

        const { data, error } = await query.select('*, service_type:service_types(*)').single();

        if (error) {
            if (error.code === 'PGRST116') {
                throw new Error('Job status has changed or job not found. Please refresh.');
            }

            throw error;
        }

        await this.logStatusHistory(bookingId, nextStatus, notes);
        await this.eventService.logEvent(bookingId, 'status_change', notes, {
            from: statusToValidate,
            to: nextStatus,
            isAdmin
        });

        const booking = this.mapJobToBooking(data);
        await this.notifyStatusChange(booking);

        if (this.activeBooking()?.id === bookingId) {
            this.activeBooking.set(booking);
        }

        return booking;
    }

    private async notifyStatusChange(booking: Booking) {
        const statusMessages: Record<BookingStatus, { title: string; body: string }> = {
            pending: { title: 'Booking Pending', body: 'Your booking is being processed.' },
            requested: { title: 'Booking Requested', body: 'Your booking has been received.' },
            searching: { title: 'Searching for Driver', body: 'We are looking for a driver for your request.' },
            assigned: { title: 'Driver Assigned', body: 'A driver has been assigned to your booking.' },
            accepted: { title: 'Driver Accepted', body: 'Your driver is on the way!' },
            heading_to_pickup: { title: 'Driver Heading to Pickup', body: 'Your driver is heading to the pickup location.' },
            arrived: { title: 'Driver Arrived', body: 'Your driver has arrived at the pickup location.' },
            arrived_at_store: { title: 'Driver at Store', body: 'Your driver has arrived at the store.' },
            shopping_in_progress: { title: 'Shopping in Progress', body: 'Your driver is currently shopping for your items.' },
            collected: { title: 'Items Collected', body: 'Your driver has collected your items.' },
            en_route_to_customer: { title: 'En Route to You', body: 'Your driver is on the way to your delivery location.' },
            delivered: { title: 'Items Delivered', body: 'Your driver has delivered your items.' },
            in_progress: { title: 'Trip Started', body: 'Your trip is now in progress.' },
            settled: { title: 'Errand Settled', body: 'The funds for your errand have been settled.' },
            completed: { title: 'Trip Completed', body: 'Thank you for choosing Movabi!' },
            cancelled: { title: 'Booking Cancelled', body: 'Your booking has been cancelled.' },
            no_driver_found: { title: 'No Driver Found', body: 'We could not find a driver for your request. Please try again later.' }
        };

        const msg = statusMessages[booking.status];

        if (!msg) return;

        await this.notificationService.notify(
            booking.customer_id,
            msg.title,
            msg.body,
            'booking',
            { bookingId: booking.id }
        );

        if (booking.driver_id) {
            await this.notificationService.notify(
                booking.driver_id,
                msg.title,
                msg.body,
                'booking',
                { bookingId: booking.id }
            );
        }

        if (booking.status === 'completed') {
            this.getBooking(booking.id)
                .then(fullBooking => {
                    this.emailService.sendJobReceipt(fullBooking).catch(e => {
                        console.error('[BookingService] Failed to send completion email:', e);
                    });
                })
                .catch(e => {
                    console.error('[BookingService] Failed to fetch booking for email:', e);
                });
        }
    }

    async getBooking(bookingId: string): Promise<Booking> {
        const { data, error } = await this.supabase
            .from('jobs')
            .select('*, service_type:service_types(*)')
            .eq('id', bookingId)
            .single();

        if (error) throw error;

        if (data.customer_id) {
            const { data: customer } = await this.supabase
                .from('profiles')
                .select('*')
                .eq('id', data.customer_id)
                .single();

            data.customer = customer;
        }

        if (data.driver_id) {
            const { data: driver } = await this.supabase
                .from('profiles')
                .select('*')
                .eq('id', data.driver_id)
                .single();

            data.driver = driver;
        }

        return this.mapJobToBooking(data);
    }

    public mapJobToBooking(job: any): Booking {
        return {
            ...job,
            id: job.id,
            customer_id: job.customer_id,
            driver_id: job.driver_id,
            service_type_id: job.service_type_id,
            service_slug: job.service_type?.slug || job.service_slug,
            status: job.status as BookingStatus,
            price: job.price,
            total_price: job.total_price || job.price,
            pickup_address: job.pickup_address,
            pickup_lat: job.pickup_lat,
            pickup_lng: job.pickup_lng,
            dropoff_address: job.dropoff_address,
            dropoff_lat: job.dropoff_lat,
            dropoff_lng: job.dropoff_lng,
            created_at: job.created_at,
            service_type: job.service_type,
            driver: job.driver,
            customer: job.customer,
            errand_details: job.errand_details,
            errand_funding: job.errand_funding,

            country_code: job.country_code,
            currency_code: job.currency_code,
            currency_symbol: job.currency_symbol,
            regional_pricing_rule_id: job.regional_pricing_rule_id,
            pricing_plan_used: job.pricing_plan_used,
            base_fare_used: job.base_fare_used,
            price_per_km_used: job.price_per_km_used,
            commission_rate_used: job.commission_rate_used,
            platform_fee: job.platform_fee,
            driver_payout: job.driver_payout,
            tax_amount: job.tax_amount,
            surge_multiplier: job.surge_multiplier
        } as Booking;
    }

    async confirmJobPayment(jobId: string, paymentIntentId: string) {
        const isWallet = paymentIntentId === 'wallet_funded';

        const { data, error } = await this.supabase
            .from('jobs')
            .update({
                payment_status: isWallet ? 'wallet_funded' : 'authorized',
                payment_intent_id: isWallet ? null : paymentIntentId,
                status: 'searching'
            })
            .eq('id', jobId)
            .select('*, service_type:service_types(*)')
            .single();

        if (error) throw error;

        await this.logStatusHistory(
            jobId,
            'searching',
            isWallet
                ? 'Wallet funds reserved, job is now dispatchable'
                : 'Payment authorized, job is now dispatchable'
        );

        await this.eventService.logEvent(
            jobId,
            'payment_succeeded',
            isWallet ? 'Payment confirmed via Wallet' : 'Payment authorized via Stripe'
        );

        const booking = this.mapJobToBooking(data);
        this.activeBooking.set(booking);

        return booking;
    }

    private async logStatusHistory(bookingId: string, status: BookingStatus, notes?: string) {
        const user = this.auth.currentUser();

        await this.supabase
            .from('booking_status_history')
            .insert({
                job_id: bookingId,
                status,
                changed_by: user?.id,
                notes
            });
    }

    async getBookingDetails(bookingId: string, serviceCode: ServiceTypeEnum): Promise<unknown> {
        const table = this.getDetailsTable(serviceCode);

        const { data, error } = await this.supabase
            .from(table)
            .select('*')
            .eq('job_id', bookingId)
            .single();

        if (error) throw error;
        return data;
    }

    async getHistory() {
        const user = this.auth.currentUser();
        if (!user) return;

        const { data, error } = await this.supabase
            .from('jobs')
            .select('*, service_type:service_types(*), driver:profiles(*)')
            .eq('customer_id', user.id)
            .order('created_at', { ascending: false });

        if (error) throw error;

        const bookings = (data || []).map(job => this.mapJobToBooking(job));
        this.bookingHistory.set(bookings);
    }

    async rateBooking(bookingId: string, score: number, comment: string) {
        const { error } = await this.supabase
            .from('ratings')
            .insert({
                booking_id: bookingId,
                customer_id: this.auth.currentUser()?.id,
                score,
                comment
            });

        if (error) throw error;
    }

    async cancelBooking(bookingId: string, reason: string) {
        try {
            const response = await firstValueFrom(
                this.http.post<{
                    data?: Booking;
                    message?: string;
                }>(this.apiUrlService.getApiUrl('/api/booking/cancel'), {
                    jobId: bookingId,
                    reason
                })
            );

            if (response?.data) {
                this.activeBooking.set(response.data);
            } else {
                try {
                    const refreshedBooking = await this.getBooking(bookingId);
                    this.activeBooking.set(refreshedBooking);
                } catch (refreshError) {
                    console.warn('[BookingService] Booking cancelled, but failed to refresh booking state.', refreshError);
                }
            }

            await this.eventService.logEvent(
                bookingId,
                'job_cancelled',
                `Cancellation reason: ${reason}`
            );

            return response;
        } catch (error: unknown) {
            console.error('[BookingService] Failed to cancel booking via API', error);

            let message = 'Unable to cancel booking right now. Please try again.';

            if (typeof error === 'object' && error !== null && 'error' in error) {
                const apiError = error as { error?: { message?: string; error?: string } };
                message = apiError.error?.message || apiError.error?.error || message;
            } else if (error instanceof Error && error.message) {
                message = error.message;
            }

            throw new Error(message);
        }
    }

    async getErrandFunding(bookingId: string): Promise<ErrandFunding | null> {
        const { data, error } = await this.supabase
            .from('errand_funding')
            .select('*')
            .eq('job_id', bookingId)
            .maybeSingle();

        if (error) {
            console.error('[BookingService] Error fetching errand funding:', error);
            throw error;
        }

        return data as ErrandFunding;
    }

    subscribeToBooking(bookingId: string): RealtimeChannel {
        const channel = this.supabase
            .channel(`booking-${bookingId}`)
            .on(
                'postgres_changes',
                {
                    event: 'UPDATE',
                    schema: 'public',
                    table: 'jobs',
                    filter: `id=eq.${bookingId}`
                },
                async () => {
                    const booking = await this.getBooking(bookingId);
                    this.activeBooking.set(booking);
                }
            )
            .subscribe();

        return channel;
    }
}
import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import {
    loadStripe,
    Stripe,
    StripeCardElement
} from '@stripe/stripe-js';
import { environment } from '../../../../environments/environment';
import { firstValueFrom } from 'rxjs';
import { JobEventService } from '../job/job-event.service';
import { ApiUrlService } from '../api-url.service';

export interface CreateJobPaymentIntentResponse {
    clientSecret: string;
}

export interface CreateWalletTopupIntentResponse {
    clientSecret: string;
    paymentIntentId: string;
}

@Injectable({
    providedIn: 'root'
})
export class PaymentService {
    private http = inject(HttpClient);
    private eventService = inject(JobEventService);
    private apiUrlService = inject(ApiUrlService);

    private stripePromise: Promise<Stripe | null> | null = null;
    private readonly apiUrl = this.apiUrlService.getApiUrl('/api/payment');

    // ✅ Safe singleton Stripe loader
    async getStripe(): Promise<Stripe | null> {
        if (!this.stripePromise) {
            const key = environment.stripePublicKey?.trim();

            if (!key) {
                console.warn('[PaymentService] Missing Stripe public key');
                return Promise.resolve(null);
            }

            this.stripePromise = loadStripe(key);
        }

        return this.stripePromise;
    }

    // =========================
    // JOB PAYMENT
    // =========================

    async createPaymentIntent(
        jobId: string,
        amount: number,
        currency: string,
        tenantId: string,
        surgeMultiplier = 1.0
    ): Promise<CreateJobPaymentIntentResponse> {

        if (!environment.stripePublicKey) {
            throw new Error('Payment service unavailable');
        }

        if (!jobId?.trim()) {
            throw new Error('jobId is required');
        }

        if (!Number.isFinite(amount) || amount <= 0) {
            throw new Error('Amount must be greater than zero');
        }

        await this.eventService.logEvent(
            jobId,
            'payment_initiated',
            'Payment intent requested',
            { amount, currency, surgeMultiplier }
        );

        try {
            const response = await firstValueFrom(
                this.http.post<CreateJobPaymentIntentResponse>(
                    `${this.apiUrl}/create-intent`,
                    {
                        jobId,
                        amount,
                        currency,
                        tenantId,
                        surgeMultiplier
                    }
                )
            );

            if (!response?.clientSecret) {
                throw new Error('Invalid payment response');
            }

            return response;

        } catch (error: any) {
            console.error('[PaymentService] createPaymentIntent failed:', error);
            throw new Error(error?.error?.error || 'Failed to initialize payment');
        }
    }

    // =========================
    // WALLET TOP-UP
    // =========================

    async createWalletTopupIntent(
        amount: number,
        currencyCode: string,
        userId?: string,
        tenantId?: string
    ): Promise<CreateWalletTopupIntentResponse> {

        if (!environment.stripePublicKey) {
            throw new Error('Payment service unavailable');
        }

        if (!Number.isFinite(amount) || amount <= 0) {
            throw new Error('Top-up amount must be greater than zero');
        }

        if (!currencyCode?.trim()) {
            throw new Error('currencyCode is required');
        }

        try {
            const response = await firstValueFrom(
                this.http.post<CreateWalletTopupIntentResponse>(
                    `${this.apiUrl}/create-wallet-topup-intent`,
                    {
                        userId,
                        amount,
                        currency: currencyCode,
                        tenantId
                    }
                )
            );

            if (!response?.clientSecret || !response?.paymentIntentId) {
                throw new Error('Invalid wallet intent response');
            }

            return response;

        } catch (error: any) {
            console.error('[PaymentService] createWalletTopupIntent failed:', error);
            throw new Error(error?.error?.error || 'Failed to initialize wallet top-up');
        }
    }

    // =========================
    // STRIPE CONFIRMATION
    // =========================

    async confirmCardPayment(
        clientSecret: string,
        cardElement: StripeCardElement
    ) {
        const stripe = await this.getStripe();

        if (!stripe) {
            throw new Error('Payment service unavailable');
        }

        if (!clientSecret?.trim()) {
            throw new Error('clientSecret is required');
        }

        if (!cardElement) {
            throw new Error('Card element is not ready');
        }

        const result = await stripe.confirmCardPayment(clientSecret, {
            payment_method: {
                card: cardElement,
                billing_details: {
                    name: 'Customer'
                }
            }
        });

        if (result.error) {
            throw new Error(result.error.message || 'Payment failed');
        }

        if (!result.paymentIntent) {
            throw new Error('Payment confirmation failed');
        }

        return result.paymentIntent;
    }

    // ✅ Backward compatibility
    async confirmPayment(
        clientSecret: string,
        cardElement: StripeCardElement
    ) {
        return this.confirmCardPayment(clientSecret, cardElement);
    }

    // =========================
    // WALLET FINALIZATION
    // =========================

    async confirmWalletTopup(data: {
        paymentIntentId: string;
        userId: string;
        amount: number;
    }): Promise<unknown> {

        if (!data?.paymentIntentId || !data?.userId || !data?.amount) {
            throw new Error('Invalid wallet confirmation data');
        }

        try {
            return await firstValueFrom(
                this.http.post(`${this.apiUrl}/confirm-wallet-topup`, data)
            );
        } catch (error: any) {
            console.error('[PaymentService] confirmWalletTopup failed:', error);
            throw new Error(error?.error?.error || 'Wallet update failed');
        }
    }

    // =========================
    // WALLET TRANSACTIONS
    // =========================

    async getTransactions(userId: string): Promise<Record<string, unknown>[]> {
        if (!userId) {
            throw new Error('userId is required');
        }

        try {
            return await firstValueFrom(
                this.http.get<Record<string, unknown>[]>(
                    `${this.apiUrlService.getApiUrl('/api/wallet')}/transactions`,
                    { params: { userId } }
                )
            );
        } catch (error: any) {
            console.error('[PaymentService] getTransactions failed:', error);
            return [];
        }
    }

    // =========================
    // REFUNDS
    // =========================

    async refundPayment(
        paymentIntentId: string,
        amount?: number,
        reason?: string
    ): Promise<unknown> {

        if (!paymentIntentId) {
            throw new Error('paymentIntentId is required');
        }

        try {
            return await firstValueFrom(
                this.http.post(`${this.apiUrl}/refund`, {
                    paymentIntentId,
                    amount,
                    reason
                })
            );
        } catch (error: any) {
            console.error('[PaymentService] refundPayment failed:', error);
            throw new Error(error?.error?.error || 'Refund failed');
        }
    }
}
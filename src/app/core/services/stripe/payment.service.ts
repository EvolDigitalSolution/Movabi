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

    async getStripe(): Promise<Stripe | null> {
        if (!this.stripePromise) {
            const key = environment.stripePublicKey?.trim();

            if (!key) {
                console.warn('Stripe public key is missing. Payment features will be disabled.');
                return Promise.resolve(null);
            }

            this.stripePromise = loadStripe(key);
        }

        return this.stripePromise;
    }

  async createPaymentIntent(
        jobId: string,
        amount: number,
        currency: string,
        tenantId: string,
        surgeMultiplier = 1.0
    ): Promise<CreateJobPaymentIntentResponse> {
        if (!environment.stripePublicKey) {
            throw new Error('Payment service is currently unavailable (missing configuration).');
        }

        if (!jobId) {
            throw new Error('jobId is required');
        }

        if (!Number.isFinite(amount) || amount <= 0) {
            throw new Error('Amount must be greater than zero');
        }

        await this.eventService.logEvent(
            jobId,
            'payment_initiated',
            'Payment intent creation requested',
            { amount, currency, surgeMultiplier }
        );

        return firstValueFrom(
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
    }

    async createWalletTopupIntent(
        amount: number,
        currencyCode: string,
        userId?: string,
        tenantId?: string
    ): Promise<CreateWalletTopupIntentResponse> {
        if (!environment.stripePublicKey) {
            throw new Error('Payment service is currently unavailable (missing configuration).');
        }

        if (!Number.isFinite(amount) || amount <= 0) {
            throw new Error('Top-up amount must be greater than zero');
        }

        if (!currencyCode?.trim()) {
            throw new Error('currencyCode is required');
        }

        return firstValueFrom(
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
    }

    async confirmCardPayment(
        clientSecret: string,
        cardElement: StripeCardElement
    ) {
        const stripe = await this.getStripe();

        if (!stripe) {
            throw new Error('Payment service is unavailable. Please contact support.');
        }

        if (!clientSecret?.trim()) {
            throw new Error('clientSecret is required');
        }

        if (!cardElement) {
            throw new Error('A Stripe card element is required to confirm payment.');
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
            throw new Error(result.error.message || 'Payment confirmation failed');
        }

        if (!result.paymentIntent) {
            throw new Error('Payment confirmation did not return a payment intent');
        }

        return result.paymentIntent;
    }

    // Backward-compatible wrapper for existing booking flow callers.
    async confirmPayment(
        clientSecret: string,
        cardElement: StripeCardElement
    ) {
        const stripe = await this.getStripe();

        if (!stripe) {
            throw new Error('Payment service is unavailable. Please contact support.');
        }

        if (!clientSecret?.trim()) {
            throw new Error('clientSecret is required');
        }

        if (!cardElement) {
            throw new Error('Card details are required to confirm this payment.');
        }

        return this.confirmCardPayment(clientSecret, cardElement);
    }

    async confirmWalletTopup(data: {
        paymentIntentId: string;
        userId: string;
        amount: number;
    }): Promise<unknown> {
        return firstValueFrom(
            this.http.post(`${this.apiUrl}/confirm-wallet-topup`, data)
        );
    }

    async getTransactions(userId: string): Promise<Record<string, unknown>[]> {
        return firstValueFrom(
            this.http.get<Record<string, unknown>[]>(`${this.apiUrlService.getApiUrl('/api/wallet')}/transactions`, {
                params: { userId }
            })
        );
    }

    async refundPayment(paymentIntentId: string, amount?: number, reason?: string): Promise<unknown> {
        return firstValueFrom(
            this.http.post(`${this.apiUrl}/refund`, {
                paymentIntentId,
                amount,
                reason
            })
        );
    }
}

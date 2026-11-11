import { Component, ElementRef, EventEmitter, Input, OnDestroy, Output, ViewChild, inject, signal } from '@angular/core';
import type { Stripe, StripeCardElement } from '@stripe/stripe-js';
import { PaymentService } from '../../core/services/stripe/payment.service';

/** What the parent must do next. 'verify': a charge may have happened, so ask the server
 * (the only source of truth for credit). 'close': the driver left without paying. */
export interface DriverTopupProviderResult { next: 'verify' | 'close'; detail?: string; }

/**
 * Stripe boundary for the driver top-up. Everything Stripe-specific lives here: Stripe.js,
 * the Card Element, card confirmation and 3D Secure. The parent only passes the server-issued
 * client secret of the attempt's ORIGINAL PaymentIntent and reacts to the result.
 *
 * Lifecycle mirrors the working customer card pages (marketplace payment / payment methods):
 * the shared PaymentService.getStripe() singleton, and mounting from a @ViewChild setter, so
 * the Card Element is mounted exactly when its host exists in the DOM, never before.
 * Stripe errors are shown to the driver; they are never swallowed into a status re-check that
 * would re-open the same screen. The client secret is never logged or displayed.
 */
@Component({
  selector: 'app-driver-topup-stripe-card', standalone: true,
  template: `
  <div class="my-3" aria-label="Stripe card payment">
    @if (mode === 'card') {
      @if (!cardReady() && !failure()) { <p class="text-sm text-slate-500" role="status">Loading secure card form…</p> }
      <div #cardHost class="border rounded-xl p-3 my-3 bg-white" aria-label="Card details"></div>
      @if (cardError()) { <p class="text-sm text-rose-700" role="alert">{{cardError()}}</p> }
      <button type="button" class="rounded-xl bg-slate-950 text-white px-4 py-3" [disabled]="busy() || !cardReady() || !cardComplete()" (click)="pay()">Pay {{amountLabel}}</button>
      <button type="button" class="p-3 ml-2" [disabled]="busy()" (click)="leave()">Not now</button>
    } @else {
      <p class="text-sm" role="status">{{busy() ? 'Opening your bank’s confirmation…' : 'Bank confirmation finished. Checking the payment…'}}</p>
    }
    @if (failure()) { <p class="text-sm text-rose-700" role="alert">{{failure()}}</p> }
  </div>`
})
export class DriverTopupStripeCardComponent implements OnDestroy {
  private readonly payments = inject(PaymentService);
  /** Server-issued client secret of the attempt's ORIGINAL PaymentIntent. */
  @Input({required:true}) clientSecret = '';
  /** 'card': collect card details; 'authenticate': finish pending 3D Secure on the same PaymentIntent. */
  @Input() mode: 'card' | 'authenticate' = 'card';
  @Input() amountLabel = '';
  @Output() readonly done = new EventEmitter<DriverTopupProviderResult>();
  readonly cardReady = signal(false);
  readonly cardComplete = signal(false);
  readonly cardError = signal('');
  readonly failure = signal('');
  readonly busy = signal(false);
  private stripe: Stripe | null = null;
  private card: StripeCardElement | null = null;
  private host: HTMLElement | null = null;
  private destroyed = false;
  private started = false;

  @ViewChild('cardHost') set cardHostRef(ref: ElementRef<HTMLElement> | undefined) {
    if (ref && !this.host) { this.host = ref.nativeElement; void this.start(); }
  }
  ngOnInit() { if (this.mode === 'authenticate') void this.start(); }
  ngOnDestroy() { this.destroyed = true; try { this.card?.destroy(); } catch { /* already gone */ } this.card = null; }

  private validSecret(): boolean { return /^pi_[A-Za-z0-9]+_secret_[A-Za-z0-9]+$/.test(this.clientSecret); }

  private async start() {
    if (this.started) return; this.started = true;
    if (!this.validSecret()) { this.failure.set('This payment cannot be opened in the card form. Check its status, or discard it.'); return; }
    this.busy.set(this.mode === 'authenticate');
    try {
      this.stripe = await this.payments.getStripe();
      if (this.destroyed) return;
      if (!this.stripe) throw Error('Stripe unavailable');
      if (this.mode === 'authenticate') { await this.authenticate(); return; }
      this.card = this.stripe.elements().create('card', {hidePostalCode:true});
      this.card.on('ready', () => this.cardReady.set(true));
      this.card.on('change', event => { this.cardComplete.set(!!event.complete && !event.error); this.cardError.set(event.error?.message || ''); });
      this.card.mount(this.host!);
    } catch {
      this.failure.set('The secure card form could not be loaded. Nothing was charged. Check your connection and try again.');
    } finally { if (this.mode === 'card') this.busy.set(false); }
  }

  async pay() {
    if (this.busy() || !this.stripe || !this.card || !this.cardComplete()) return;
    this.busy.set(true); this.failure.set('');
    try {
      const result = await this.stripe.confirmCardPayment(this.clientSecret, {payment_method:{card:this.card}});
      if (this.destroyed) return;
      const status = result.paymentIntent?.status ?? result.error?.payment_intent?.status;
      if (result.paymentIntent) { this.done.emit({next:'verify'}); return; }
      const e = result.error;
      const detail = (e?.message || 'Stripe could not process this payment.') + (e?.code ? ' (' + e.code + ')' : '');
      // The same PaymentIntent is still payable: keep the form so the driver can correct or retry.
      if (e?.type === 'card_error' || e?.type === 'validation_error' || status === 'requires_payment_method') {
        this.failure.set(detail + ' No payment was taken. You can correct the details and try again.');
        return;
      }
      // Anything else may or may not have charged: show the reason, then let the server decide.
      this.done.emit({next:'verify', detail});
    } catch {
      this.done.emit({next:'verify', detail:'The payment result is unknown; do not pay again.'});
    } finally { this.busy.set(false); }
  }

  private async authenticate() {
    let detail: string | undefined;
    try {
      const result = await this.stripe!.handleNextAction({clientSecret:this.clientSecret});
      if (result.error) detail = (result.error.message || 'Bank confirmation did not complete.') + (result.error.code ? ' (' + result.error.code + ')' : '');
    } catch { detail = 'Bank confirmation could not be opened.'; }
    finally { this.busy.set(false); }
    if (!this.destroyed) this.done.emit({next:'verify', detail});
  }

  leave() { if (!this.busy()) this.done.emit({next:'close'}); }
}

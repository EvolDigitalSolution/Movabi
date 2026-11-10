import { CommonModule } from '@angular/common';
import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IonBackButton, IonButtons, IonContent, IonHeader, IonTitle, IonToolbar } from '@ionic/angular/standalone';
import type { Stripe, StripeCardElement } from '@stripe/stripe-js';
import { PaymentService } from '@core/services/stripe/payment.service';

type SavedCard = {id:string;brand:string;last4:string;expMonth:number;expYear:number};
@Component({
  selector: 'app-payment-methods', standalone: true,
  imports: [CommonModule, FormsModule, IonBackButton, IonButtons, IonContent, IonHeader, IonTitle, IonToolbar],
  template: `
    <ion-header><ion-toolbar><ion-buttons slot="start"><ion-back-button defaultHref="/customer" /></ion-buttons><ion-title>Payment methods</ion-title></ion-toolbar></ion-header>
    <ion-content>
      <main class="mx-auto max-w-xl space-y-5 p-4 pb-24">
        <h1 class="text-2xl font-bold">Your saved cards</h1>
        <p>Saving a card is optional. You choose a payment method when paying for a booking.</p>
        <p role="status" aria-live="polite">{{ notice() }}</p>
        @if (loading()) { <p>Loading payment methods…</p> }
        @if (error()) { <div role="alert" class="rounded-xl bg-rose-50 p-4 text-rose-800">{{ error() }}</div> }
        @if (!loading() && !loaded()) {
          <button type="button" class="rounded-xl border p-3" [disabled]="busy()" (click)="refresh()">Retry loading</button>
        }
        @for (card of cards(); track card.id) {
          <section class="rounded-2xl border border-slate-200 p-4">
            <h2 class="font-bold">{{ card.brand | titlecase }} •••• {{ card.last4 }}</h2>
            <p>Expires {{ card.expMonth }}/{{ card.expYear }} @if (expired(card)) { <span>— expired</span> }</p>
            @if (removing() === card.id) {
              <p class="mt-3">Remove this saved card? Existing payment and refund records will remain.</p>
              <button type="button" class="mr-3 rounded-xl border p-3" [disabled]="busy()" (click)="remove(card)">Confirm removal</button>
              <button type="button" class="rounded-xl border p-3" [disabled]="busy()" (click)="removing.set(null)">Keep card</button>
            } @else {
              <button type="button" class="mt-3 rounded-xl border p-3" [disabled]="busy()" (click)="removing.set(card.id)">Remove card</button>
            }
          </section>
        }
        @if (loaded() && !cards().length) { <p>You have no saved cards.</p> }
        @if (loaded() && !canAdd()) {
          <p>Adding cards is not currently available for your market. Available payment choices are shown at checkout.</p>
        }
        @if (loaded() && canAdd() && !showForm()) {
          <button type="button" class="rounded-xl bg-slate-900 p-3 text-white" [disabled]="busy()" (click)="openForm()">Add a card</button>
        }
        <section [hidden]="!showForm()" class="space-y-4 rounded-2xl border p-4">
          <h2 class="font-bold">Add a card securely</h2>
          <p>Card details are entered directly into Stripe’s secure payment form. Vaydu does not store your full card number or security code.</p>
          <div #cardSlot class="rounded-xl border bg-white p-4"></div>
          <label class="flex items-start gap-3"><input type="checkbox" [(ngModel)]="consent" [disabled]="busy()" />
            <span>I agree to save this card with Vaydu’s payment provider for future payments that I initiate while using Vaydu. I can remove it here at any time.</span>
          </label>
          <button type="button" class="rounded-xl bg-slate-900 p-3 text-white disabled:opacity-50" [disabled]="busy() || !consent || !complete()" (click)="save()">{{ busy() ? 'Please wait…' : 'Save card' }}</button>
          <p>Saving a card does not pay for a booking.</p>
        </section>
      </main>
    </ion-content>`
})
export class PaymentMethodsPage implements AfterViewInit, OnDestroy {
  private payments = inject(PaymentService);
  @ViewChild('cardSlot', {static:true}) private cardSlot!: ElementRef<HTMLDivElement>;
  readonly loading = signal(true); readonly loaded = signal(false); readonly busy = signal(false);
  readonly error = signal(''); readonly notice = signal(''); readonly canAdd = signal(false);
  readonly cards = signal<SavedCard[]>([]); readonly removing = signal<string|null>(null);
  readonly showForm = signal(false); readonly complete = signal(false);
  consent = false;
  private consentVersion = ''; private stripe: Stripe|null = null; private element: StripeCardElement|null = null;
  private requestId: string|null = null; private setup: {clientSecret:string;setupIntentId:string}|null = null;
  private destroyed = false;
  ngAfterViewInit() { void this.refresh(); }
  ngOnDestroy() { this.destroyed = true; this.element?.destroy(); }
  async refresh() {
    if (this.busy()) return;
    this.loading.set(true); this.error.set(''); this.loaded.set(false);
    try {
      const wallet = await this.payments.cardWallet();
      if (this.destroyed) return;
      this.cards.set(wallet.cards); this.canAdd.set(wallet.canAdd); this.consentVersion = wallet.consentVersion;
      if (!wallet.canAdd) { this.showForm.set(false); this.element?.destroy(); this.element = null; }
      this.loaded.set(true);
    } catch (error) {
      if ((error as {status?:number})?.status === 404) { this.cards.set([]); this.canAdd.set(false); this.loaded.set(true); }
      else this.error.set('Payment methods could not be loaded. Please retry.');
    }
    finally { this.loading.set(false); }
  }
  expired(card:SavedCard):boolean {
    const now = new Date(); return card.expYear < now.getFullYear() || (card.expYear === now.getFullYear() && card.expMonth < now.getMonth()+1);
  }
  async openForm() {
    if (!this.canAdd() || this.busy() || this.showForm()) return;
    this.busy.set(true); this.error.set('');
    try {
      this.stripe = await this.payments.getStripe();
      if (this.destroyed) return;
      if (!this.stripe) throw Error('Unavailable');
      this.showForm.set(true);
      this.element = this.stripe.elements().create('card', {hidePostalCode:false});
      this.element.on('change', event => { this.complete.set(event.complete); this.error.set(event.error?.message || ''); });
      this.element.mount(this.cardSlot.nativeElement);
    } catch { this.showForm.set(false); this.element?.destroy(); this.element = null; this.error.set('Secure card entry is unavailable. Please try again later.'); }
    finally { this.busy.set(false); }
  }
  async save() {
    if (this.busy() || !this.consent || !this.complete() || !this.element || !this.stripe || !this.canAdd()) return;
    this.busy.set(true); this.error.set(''); this.notice.set('');
    try {
      this.requestId ??= crypto.randomUUID();
      this.setup ??= await this.payments.beginCardSetup(this.requestId, this.consentVersion);
      const result = await this.stripe.confirmCardSetup(this.setup.clientSecret, {payment_method:{card:this.element}});
      if (result.error) { this.error.set(result.error.message || 'Card setup was not completed. Please try again.'); return; }
      if (!result.setupIntent || result.setupIntent.id !== this.setup.setupIntentId || result.setupIntent.status !== 'succeeded') {
        this.error.set('Card setup is not confirmed. Check your saved cards before trying again.'); return;
      }
      this.notice.set('Card saved. You can choose it at a supported checkout.');
      this.setup = null; this.requestId = null; this.consent = false;
      this.element.clear(); this.complete.set(false);
    } catch { this.error.set('Card setup could not be confirmed. Retry this form using the same request.'); }
    finally { this.busy.set(false); }
    if (this.notice()) await this.refresh();
  }
  async remove(card:SavedCard) {
    if (this.busy() || this.removing() !== card.id) return;
    this.busy.set(true); this.error.set(''); this.notice.set('');
    try { await this.payments.removeWalletCard(card.id); this.cards.update(cards => cards.filter(item => item.id !== card.id)); this.removing.set(null); this.notice.set('Saved card removed.'); }
    catch { this.error.set('Could not confirm removal. Refresh your list before trying again.'); }
    finally { this.busy.set(false); }
  }
}

import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
    AdminMarketAvailabilityService,
    MarketAvailabilityForm,
    MarketAvailabilityRow,
    MarketLaunchStatus
} from '../../services/admin-market-availability.service';
import { buildMarketScopePayload, marketScopeLabel, toDateTimeLocalValue } from './market-rollout.payload';

type CapabilityField = keyof Pick<MarketAvailabilityForm,
    | 'customer_app_enabled'
    | 'customer_registration_enabled'
    | 'driver_registration_enabled'
    | 'driver_online_enabled'
    | 'quote_enabled'
    | 'booking_enabled'
    | 'payment_enabled'
    | 'waiting_list_enabled'>;

@Component({
    selector: 'app-market-rollout',
    standalone: true,
    imports: [CommonModule, FormsModule],
    template: `
<main class="p-6 max-w-7xl mx-auto">
  <div class="flex flex-col sm:flex-row gap-3 sm:items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold text-slate-950">Market Rollout</h1>
      <p class="text-slate-500">Backend-enforced country, city and zone capabilities.</p>
    </div>
    <button type="button" class="shrink-0 whitespace-nowrap px-4 py-2 bg-blue-600 text-white rounded font-semibold" (click)="create()">New scope</button>
  </div>

  @if (toast()) {
    <div
      class="mt-4 rounded-xl px-4 py-3 text-sm font-semibold"
      [class.bg-emerald-50]="toastType() === 'success'"
      [class.text-emerald-700]="toastType() === 'success'"
      [class.bg-rose-50]="toastType() === 'error'"
      [class.text-rose-700]="toastType() === 'error'"
      role="status"
    >{{ toast() }}</div>
  }

  <div class="grid lg:grid-cols-2 gap-5 mt-6">
    <section class="bg-white border rounded p-4 overflow-x-auto">
      <table class="w-full text-sm">
        <thead><tr><th class="text-left">Scope</th><th class="text-left">Status</th><th class="text-left">Quote</th><th></th></tr></thead>
        <tbody>
          @for (row of rows(); track row.id) {
            <tr class="border-t">
              <td class="py-2">{{ row.country_code }} / {{ row.market_city || 'Country' }} / {{ row.zone_id || 'All zones' }}</td>
              <td class="py-2">{{ row.launch_status }}</td>
              <td class="py-2">{{ row.quote_enabled ? 'On' : 'Off' }}</td>
              <td class="py-2 text-right"><button type="button" class="text-blue-600 font-semibold" (click)="edit(row)">Edit</button></td>
            </tr>
          }
        </tbody>
      </table>
    </section>

    @if (form()) {
      <form class="bg-white border rounded p-5 grid grid-cols-1 sm:grid-cols-2 gap-4" (ngSubmit)="save()">
        <label class="flex flex-col gap-1 text-sm font-semibold text-slate-700">Country
          <input class="w-full rounded border border-slate-200 px-3 py-2" name="country" maxlength="2" [(ngModel)]="form()!.country_code">
        </label>
        <label class="flex flex-col gap-1 text-sm font-semibold text-slate-700">City
          <input class="w-full rounded border border-slate-200 px-3 py-2" name="city" [(ngModel)]="form()!.market_city">
        </label>
        <label class="flex flex-col gap-1 text-sm font-semibold text-slate-700">Scope
          <input class="w-full rounded border border-slate-200 bg-slate-50 px-3 py-2 text-slate-500" [value]="scopeLabel()" readonly>
        </label>
        <label class="flex flex-col gap-1 text-sm font-semibold text-slate-700">Status
          <select class="w-full rounded border border-slate-200 px-3 py-2" name="status" [(ngModel)]="form()!.launch_status">
            @for (s of statuses; track s) { <option [value]="s">{{ s }}</option> }
          </select>
        </label>
        <label class="flex flex-col gap-1 text-sm font-semibold text-slate-700">Currency
          <input class="w-full rounded border border-slate-200 px-3 py-2" name="currency" maxlength="3" [(ngModel)]="form()!.supported_currency">
        </label>
        <label class="flex flex-col gap-1 text-sm font-semibold text-slate-700">Timezone
          <input class="w-full rounded border border-slate-200 px-3 py-2" name="timezone" [(ngModel)]="form()!.timezone">
        </label>
        <label class="sm:col-span-2 flex flex-col gap-1 text-sm font-semibold text-slate-700">Title
          <input class="w-full rounded border border-slate-200 px-3 py-2" name="title" [(ngModel)]="form()!.unavailable_title">
        </label>
        <label class="sm:col-span-2 flex flex-col gap-1 text-sm font-semibold text-slate-700">Message
          <textarea class="w-full rounded border border-slate-200 px-3 py-2" rows="3" name="message" [(ngModel)]="form()!.unavailable_message"></textarea>
        </label>

        <div class="sm:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
          @for (c of capabilityFields; track c.key) {
            <label class="flex items-center gap-2 text-sm"><input type="checkbox" [name]="c.key" [(ngModel)]="form()![c.key]"> {{ c.label }}</label>
          }
        </div>

        <label class="flex flex-col gap-1 text-sm font-semibold text-slate-700">Valid from
          <input class="w-full rounded border border-slate-200 px-3 py-2" type="datetime-local" name="validFrom" [(ngModel)]="form()!.valid_from">
        </label>
        <label class="flex items-center gap-2 text-sm font-semibold text-slate-700"><input type="checkbox" name="enabled" [(ngModel)]="form()!.enabled"> Active</label>

        <div class="sm:col-span-2 flex flex-col sm:flex-row gap-3">
          <button
            type="submit"
            class="shrink-0 whitespace-nowrap px-5 py-2 bg-blue-600 text-white rounded font-semibold disabled:opacity-50"
            [disabled]="saving()"
          >{{ saving() ? 'Saving…' : (form()!.id ? 'Update scope' : 'Create scope') }}</button>
          <button type="button" class="shrink-0 whitespace-nowrap px-5 py-2 bg-slate-100 text-slate-700 rounded font-semibold" (click)="cancel()">Cancel</button>
        </div>
      </form>
    }
  </div>
</main>`
})
export class MarketRolloutComponent implements OnInit {
    private api = inject(AdminMarketAvailabilityService);
    rows = signal<MarketAvailabilityRow[]>([]);
    form = signal<MarketAvailabilityForm | null>(null);
    saving = signal(false);
    toast = signal<string | null>(null);
    toastType = signal<'success' | 'error'>('success');
    readonly statuses: readonly MarketLaunchStatus[] = [
        'disabled', 'coming_soon', 'driver_onboarding', 'customer_beta', 'live', 'paused'
    ];
    readonly capabilityFields: ReadonlyArray<{ key: CapabilityField; label: string }> = [
        { key: 'customer_app_enabled', label: 'Customer app' },
        { key: 'customer_registration_enabled', label: 'Customer registration' },
        { key: 'driver_registration_enabled', label: 'Driver registration' },
        { key: 'driver_online_enabled', label: 'Driver online' },
        { key: 'quote_enabled', label: 'Quote' },
        { key: 'booking_enabled', label: 'Booking' },
        { key: 'payment_enabled', label: 'Payment' },
        { key: 'waiting_list_enabled', label: 'Waiting list' }
    ];

    async ngOnInit(): Promise<void> { await this.load(); }

    async load(): Promise<void> {
        try {
            this.rows.set(await this.api.list());
        } catch (error) {
            this.showToast(this.describeError(error, 'Could not load rollout scopes.'), 'error');
        }
    }

    /** Load an existing scope for editing (preserves its id => update path). */
    edit(row: MarketAvailabilityRow): void {
        const { created_at: _createdAt, updated_at: _updatedAt, ...form } = row;
        this.form.set({
            ...form,
            valid_from: toDateTimeLocalValue(form.valid_from),
            valid_until: toDateTimeLocalValue(form.valid_until)
        });
        this.clearToast();
    }

    /** Human-readable scope the admin is creating (never a free-text zone). */
    scopeLabel(): string {
        return marketScopeLabel(this.form()?.market_city);
    }

    /** Start a NEW scope: clears any stale id so the create path is used. */
    create(): void {
        this.form.set({
            country_code: '', market_city: null, zone_id: null, launch_status: 'coming_soon',
            customer_app_enabled: false, customer_registration_enabled: false,
            driver_registration_enabled: false, driver_online_enabled: false,
            quote_enabled: false, booking_enabled: false, payment_enabled: false,
            waiting_list_enabled: true, supported_currency: null, timezone: null,
            unavailable_title: null, unavailable_message: null, valid_from: null,
            valid_until: null, enabled: true
        });
        this.clearToast();
    }

    cancel(): void {
        this.form.set(null);
        this.clearToast();
    }

    async save(): Promise<void> {
        const form = this.form();
        if (!form || this.saving()) return;

        // Visible validation feedback — never a silent no-op.
        const country = String(form.country_code || '').trim();
        if (country.length !== 2) {
            this.showToast('Enter a valid 2-letter country code before saving.', 'error');
            return;
        }

        this.saving.set(true);
        const isUpdate = !!form.id;
        try {
            await this.api.save(buildMarketScopePayload(form));
            this.form.set(null);
            await this.load();
            this.showToast(isUpdate ? 'Scope updated.' : 'Scope created.', 'success');
        } catch (error) {
            this.showToast(this.describeError(error, isUpdate ? 'Could not update the scope.' : 'Could not create the scope.'), 'error');
        } finally {
            this.saving.set(false);
        }
    }

    private describeError(error: unknown, fallback: string): string {
        const candidate = (error as any)?.error?.error
            ?? (error as any)?.error?.message
            ?? (error as any)?.message;
        return typeof candidate === 'string' && candidate.trim() ? candidate : fallback;
    }

    private showToast(message: string, type: 'success' | 'error'): void {
        this.toastType.set(type);
        this.toast.set(message);
    }

    private clearToast(): void {
        this.toast.set(null);
    }
}

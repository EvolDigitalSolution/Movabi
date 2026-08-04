import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
    AdminMarketAvailabilityService,
    MarketAvailabilityForm,
    MarketAvailabilityRow,
    MarketLaunchStatus
} from '../../services/admin-market-availability.service';

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
<main class="p-6 max-w-7xl mx-auto"><div class="flex justify-between"><div><h1 class="text-2xl font-bold">Market Rollout</h1><p class="text-slate-500">Backend-enforced country, city and zone capabilities.</p></div><button class="px-4 py-2 bg-blue-600 text-white rounded" (click)="create()">New scope</button></div>
<div class="grid lg:grid-cols-2 gap-5 mt-6"><section class="bg-white border rounded p-4"><table class="w-full text-sm"><thead><tr><th>Scope</th><th>Status</th><th>Quote</th><th></th></tr></thead><tbody>@for(row of rows();track row.id){<tr><td>{{row.country_code}} / {{row.market_city||'Country'}} / {{row.zone_id||'All zones'}}</td><td>{{row.launch_status}}</td><td>{{row.quote_enabled?'On':'Off'}}</td><td><button class="text-blue-600" (click)="edit(row)">Edit</button></td></tr>}</tbody></table></section>
@if(form()){<form class="bg-white border rounded p-5 grid grid-cols-2 gap-3" (ngSubmit)="save()"><label>Country<input name="country" maxlength="2" [(ngModel)]="form()!.country_code"></label><label>City<input name="city" [(ngModel)]="form()!.market_city"></label><label>Zone<input name="zone" [(ngModel)]="form()!.zone_id"></label><label>Status<select name="status" [(ngModel)]="form()!.launch_status">@for(s of statuses;track s){<option [value]="s">{{s}}</option>}</select></label>
<label>Currency<input name="currency" maxlength="3" [(ngModel)]="form()!.supported_currency"></label><label>Timezone<input name="timezone" [(ngModel)]="form()!.timezone"></label><label class="col-span-2">Title<input name="title" [(ngModel)]="form()!.unavailable_title"></label><label class="col-span-2">Message<textarea name="message" [(ngModel)]="form()!.unavailable_message"></textarea></label>
@for(c of capabilityFields;track c.key){<label><input type="checkbox" [name]="c.key" [(ngModel)]="form()![c.key]"> {{c.label}}</label>}<label>Valid from<input type="datetime-local" name="validFrom" [(ngModel)]="form()!.valid_from"></label><label><input type="checkbox" name="enabled" [(ngModel)]="form()!.enabled"> Active</label>
<button class="col-span-2 py-2 bg-blue-600 text-white rounded" type="submit">Save existing scope by ID</button></form>}</div></main>`
})
export class MarketRolloutComponent implements OnInit {
    private api = inject(AdminMarketAvailabilityService);
    rows = signal<MarketAvailabilityRow[]>([]);
    form = signal<MarketAvailabilityForm | null>(null);
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
    async load(): Promise<void> { this.rows.set(await this.api.list()); }
    edit(row: MarketAvailabilityRow): void {
        const { created_at: _createdAt, updated_at: _updatedAt, ...form } = row;
        this.form.set(form);
    }
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
    }
    async save(): Promise<void> {
        const form = this.form();
        if (!form) return;
        await this.api.save(form);
        this.form.set(null);
        await this.load();
    }
}

import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
    locationOutline,
    pinOutline,
    locate,
    checkmarkCircleOutline,
    closeOutline,
    navigateOutline
} from 'ionicons/icons';

export interface AddressSuggestion {
    label: string;
    lat?: number;
    lng?: number;
    placeId?: string;
}

@Component({
    selector: 'app-compact-address-selector',
    standalone: true,
    imports: [CommonModule, IonicModule],
    template: `
    <!-- COLLAPSED / SUMMARY STATE — hidden when editing -->
    @if (!expanded) {
      <button
        type="button"
        (click)="open()"
        [attr.aria-label]="ariaLabel || (mode === 'pickup' ? 'Edit pickup address' : 'Edit dropoff address')"
        class="w-full flex items-center gap-3 min-h-[72px] px-4 py-3 rounded-[22px] border bg-white shadow-sm text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-500 focus-visible:outline-offset-2 transition-all active:scale-[0.99]"
        [class.border-slate-200]="!hasError"
        [class.border-red-300]="hasError">

        <span
          class="w-[46px] h-[46px] rounded-[14px] flex items-center justify-center shrink-0"
          [class.bg-orange-50]="mode === 'pickup' && !hasError"
          [class.text-orange-600]="mode === 'pickup' && !hasError"
          [class.bg-blue-50]="mode === 'dropoff' && !hasError"
          [class.text-blue-600]="mode === 'dropoff' && !hasError"
          [class.bg-red-50]="hasError"
          [class.text-red-500]="hasError">
          <ion-icon [name]="mode === 'pickup' ? 'location-outline' : 'pin-outline'" class="text-[22px]"></ion-icon>
        </span>

        <span class="flex-1 min-w-0">
          <span class="block text-[10px] font-black uppercase tracking-widest leading-none mb-0.5"
            [class.text-orange-600]="mode === 'pickup'"
            [class.text-blue-600]="mode === 'dropoff'">
            {{ mode === 'pickup' ? 'Pickup' : 'Drop-off' }}
          </span>

          @if (hasAddress) {
            <span class="block text-sm font-black text-slate-900 leading-snug truncate">{{ displayAddress }}</span>
            @if (mode === 'pickup' && isCurrentLocation) {
              <span class="inline-flex items-center gap-1 mt-0.5 text-[9px] font-black uppercase tracking-widest text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">
                <ion-icon name="navigate-outline" class="text-[10px]"></ion-icon>
                Current location
              </span>
            }
          } @else {
            <span class="block text-sm font-bold text-slate-400 leading-snug">
              {{ mode === 'pickup' ? 'Choose pickup address' : 'Choose delivery address' }}
            </span>
          }

          @if (autofilling) {
            <span class="block text-[10px] font-bold text-slate-400 mt-0.5" aria-live="polite">
              Finding your location…
            </span>
          }
        </span>

        @if (hasAddress) {
          <span class="shrink-0 px-3 py-2 rounded-full text-[10px] font-black uppercase tracking-widest"
            [class.bg-orange-50]="mode === 'pickup'"
            [class.text-orange-600]="mode === 'pickup'"
            [class.bg-blue-50]="mode === 'dropoff'"
            [class.text-blue-600]="mode === 'dropoff'">
            Change
          </span>
        } @else {
          <span class="shrink-0 px-3 py-2 rounded-full text-[10px] font-black uppercase tracking-widest bg-slate-100 text-slate-600">
            Add
          </span>
        }
      </button>
    }

    <!-- EDITING STATE — shown only when expanded, hides collapsed row -->
    @if (expanded) {
      <div
        class="rounded-[22px] border bg-white shadow-sm overflow-visible animate-in fade-in slide-in-from-top-1 duration-150"
        [class.border-slate-200]="!hasError"
        [class.border-red-300]="hasError">

        <!-- Editor header -->
        <div class="flex items-center gap-3 px-4 pt-4 pb-2">
          <span
            class="w-[42px] h-[42px] rounded-[12px] flex items-center justify-center shrink-0"
            [class.bg-orange-50]="mode === 'pickup'"
            [class.text-orange-600]="mode === 'pickup'"
            [class.bg-blue-50]="mode === 'dropoff'"
            [class.text-blue-600]="mode === 'dropoff'">
            <ion-icon [name]="mode === 'pickup' ? 'location-outline' : 'pin-outline'" class="text-xl"></ion-icon>
          </span>
          <span class="flex-1 min-w-0">
            <span class="block text-[10px] font-black uppercase tracking-widest"
              [class.text-orange-600]="mode === 'pickup'"
              [class.text-blue-600]="mode === 'dropoff'">
              {{ mode === 'pickup' ? 'Choose pickup' : 'Choose drop-off' }}
            </span>
          </span>
          <button
            type="button"
            (click)="cancel()"
            class="shrink-0 min-h-[36px] px-3 py-1.5 rounded-full bg-slate-100 text-slate-600 text-[10px] font-black uppercase tracking-widest focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-500">
            Cancel
          </button>
        </div>

        <div class="px-3 pb-3 space-y-2">
          <!-- Current/saved address row — keep without making it the search field -->
          @if (hasAddress) {
            <button
              type="button"
              (mousedown)="keepAndClose()"
              class="w-full flex items-center gap-3 min-h-[56px] px-4 py-3 rounded-2xl border text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-500 transition-all"
              [class.border-orange-100]="mode === 'pickup'"
              [class.bg-orange-50]="mode === 'pickup'"
              [class.border-blue-100]="mode === 'dropoff'"
              [class.bg-blue-50]="mode === 'dropoff'">
              <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white"
                [class.text-orange-600]="mode === 'pickup'"
                [class.text-blue-600]="mode === 'dropoff'">
                <ion-icon name="checkmark-circle-outline"></ion-icon>
              </span>
              <span class="min-w-0 flex-1">
                <span class="block text-[9px] font-black uppercase tracking-widest text-slate-400">
                  {{ mode === 'pickup' && isCurrentLocation ? 'Current location' : 'Saved address' }}
                </span>
                <span class="block text-sm font-black text-slate-900 truncate">{{ displayAddress }}</span>
              </span>
            </button>
          }

          <!-- Search field — always empty, never pre-filled with saved address -->
          <div class="relative">
            <div class="flex items-center gap-2 px-4 py-3 bg-white rounded-2xl border border-slate-200 shadow-sm focus-within:border-orange-400 focus-within:ring-4 focus-within:ring-orange-500/10 transition-all">
              <ion-icon name="location-outline" class="text-slate-400 text-xl shrink-0"></ion-icon>
              <input
                #searchInput
                type="text"
                [value]="searchQuery"
                (input)="onInput($event)"
                (focus)="focusChange.emit(true)"
                (blur)="onBlur()"
                [placeholder]="mode === 'pickup' ? 'Search for another address' : 'Search for a delivery address'"
                class="flex-1 bg-transparent border-0 outline-none text-slate-900 text-sm font-semibold placeholder:text-slate-400 placeholder:font-normal min-h-[44px]"
                [attr.aria-label]="mode === 'pickup' ? 'Search pickup address' : 'Search dropoff address'"
                autocomplete="off"
                autocorrect="off"
                spellcheck="false" />
            </div>

            @if (showResults && suggestions.length > 0) {
              <div class="absolute z-[9999] left-0 right-0 top-[calc(100%+6px)] bg-white rounded-2xl shadow-2xl border border-slate-100 overflow-y-auto max-h-[240px] animate-in fade-in zoom-in-95 duration-200">
                @for (result of suggestions; track result.label) {
                  <button
                    type="button"
                    (mousedown)="onSuggestionSelect(result)"
                    class="w-full min-h-[52px] px-4 py-3 text-left hover:bg-slate-50 flex items-center gap-3 border-b border-slate-50 last:border-0 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-500">
                    <div class="w-9 h-9 rounded-xl bg-slate-50 flex items-center justify-center text-slate-400 shrink-0">
                      <ion-icon [name]="mode === 'pickup' ? 'location-outline' : 'pin-outline'" class="text-base"></ion-icon>
                    </div>
                    <div class="flex-1 min-w-0">
                      <p class="text-sm font-bold text-slate-900 truncate">{{ result.label }}</p>
                      <p class="text-[9px] text-slate-400 font-bold uppercase tracking-widest">Select location</p>
                    </div>
                  </button>
                }
              </div>
            }
          </div>

          <!-- Use current location button (pickup only) -->
          @if (mode === 'pickup') {
            <button
              type="button"
              (click)="useCurrentLocation.emit()"
              class="w-full flex items-center gap-3 min-h-[48px] px-4 py-3 rounded-2xl bg-blue-50 border border-blue-100 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-500 transition-all active:scale-[0.99]">
              <span class="w-9 h-9 rounded-xl bg-white flex items-center justify-center text-blue-600 shrink-0">
                <ion-icon name="locate" class="text-lg"></ion-icon>
              </span>
              <span class="flex-1">
                <span class="block text-sm font-black text-blue-700">Use current location</span>
                <span class="block text-[10px] font-semibold text-blue-500">GPS auto-detect</span>
              </span>
            </button>
          }
        </div>
      </div>
    }
  `
})
export class CompactAddressSelectorComponent implements OnChanges {
    @Input() mode: 'pickup' | 'dropoff' = 'pickup';
    @Input() summaryAddress = '';
    @Input() summaryTitle = '';
    @Input() expanded = false;
    @Input() autofilling = false;
    @Input() hasError = false;
    @Input() ariaLabel = '';
    @Input() suggestions: AddressSuggestion[] = [];
    @Input() showResults = false;
    @Input() isCurrentLocation = false;

    /** @deprecated kept for API compatibility — use summaryAddress */
    @Input() placeholder = '';
    /** @deprecated kept for API compatibility — search field is always empty */
    @Input() inputValue = '';

    @Output() expandedChange = new EventEmitter<boolean>();
    @Output() inputChange = new EventEmitter<string>();
    @Output() suggestionSelect = new EventEmitter<AddressSuggestion>();
    @Output() useCurrentLocation = new EventEmitter<void>();
    @Output() keepCurrent = new EventEmitter<void>();
    @Output() focusChange = new EventEmitter<boolean>();

    searchQuery = '';

    get hasAddress(): boolean {
        return !!this.summaryAddress?.trim();
    }

    get displayAddress(): string {
        return this.summaryAddress?.trim() || '';
    }

    constructor() {
        addIcons({
            locationOutline,
            pinOutline,
            locate,
            checkmarkCircleOutline,
            closeOutline,
            navigateOutline
        });
    }

    ngOnChanges(changes: SimpleChanges): void {
        if (changes['expanded'] && !this.expanded) {
            this.searchQuery = '';
        }
    }

    open(): void {
        this.searchQuery = '';
        this.expanded = true;
        this.expandedChange.emit(true);
    }

    cancel(): void {
        this.searchQuery = '';
        this.expanded = false;
        this.expandedChange.emit(false);
        this.keepCurrent.emit();
    }

    keepAndClose(): void {
        this.searchQuery = '';
        this.expanded = false;
        this.expandedChange.emit(false);
        this.keepCurrent.emit();
    }

    onInput(event: Event): void {
        this.searchQuery = (event.target as HTMLInputElement).value;
        this.inputChange.emit(this.searchQuery);
    }

    onBlur(): void {
        this.focusChange.emit(false);
    }

    onSuggestionSelect(result: AddressSuggestion): void {
        this.searchQuery = '';
        this.expanded = false;
        this.expandedChange.emit(false);
        this.suggestionSelect.emit(result);
    }
}

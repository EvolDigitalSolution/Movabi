import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
    locationOutline,
    pinOutline,
    storefrontOutline,
    checkmarkCircle,
    chevronForwardOutline,
    addOutline
} from 'ionicons/icons';

@Component({
    selector: 'app-booking-summary-row',
    standalone: true,
    imports: [CommonModule, IonicModule],
    template: `
    <div
      class="flex items-center gap-3 min-h-[72px] px-4 py-3 rounded-[20px] border transition-all"
      [class.border-slate-200]="!hasError"
      [class.border-red-200]="hasError"
      [class.bg-white]="!disabled"
      [class.bg-slate-50]="disabled"
      [class.active:scale-[0.99]]="!disabled"
      [class.cursor-pointer]="!disabled"
      (click)="!disabled && action.emit()"
      role="button"
      [attr.tabindex]="disabled ? -1 : 0"
      [attr.aria-label]="ariaLabel || title"
      [attr.aria-disabled]="disabled"
      (keydown.enter)="!disabled && action.emit()"
      (keydown.space)="!disabled && action.emit()">

      <span
        class="w-[46px] h-[46px] rounded-[14px] flex items-center justify-center shrink-0"
        [class.bg-orange-50]="iconColor === 'orange'"
        [class.text-orange-500]="iconColor === 'orange'"
        [class.bg-blue-50]="iconColor === 'blue'"
        [class.text-blue-500]="iconColor === 'blue'"
        [class.bg-emerald-50]="iconColor === 'green'"
        [class.text-emerald-600]="iconColor === 'green'"
        [class.bg-slate-100]="iconColor === 'slate' || !iconColor"
        [class.text-slate-500]="iconColor === 'slate' || !iconColor"
        [class.bg-red-50]="hasError"
        [class.text-red-500]="hasError">
        <ion-icon [name]="icon" class="text-[22px]"></ion-icon>
      </span>

      <span class="flex-1 min-w-0">
        <span class="block text-[10px] font-black uppercase tracking-widest text-slate-400 leading-none mb-0.5">{{ title }}</span>
        @if (value) {
          <span class="block text-sm font-black text-slate-900 leading-snug line-clamp-2">{{ value }}</span>
        } @else {
          <span class="block text-sm font-bold text-slate-400 leading-snug">{{ emptyText }}</span>
        }
        @if (badge) {
          <span class="inline-block mt-1 px-2 py-0.5 rounded-full text-[10px] font-black bg-emerald-100 text-emerald-700">{{ badge }}</span>
        }
        @if (subtitle) {
          <span class="block text-xs font-semibold text-slate-500 mt-0.5">{{ subtitle }}</span>
        }
      </span>

      @if (!disabled) {
        <span
          class="shrink-0 px-3 py-2 rounded-full text-[10px] font-black uppercase tracking-widest flex items-center gap-1"
          [class.text-orange-600]="!value"
          [class.bg-orange-50]="!value"
          [class.text-orange-600]="!!value"
          [class.bg-orange-50]="!!value">
          @if (!value) {
            <ion-icon name="add-outline" class="text-sm"></ion-icon>
            {{ actionLabel || 'Add' }}
          } @else {
            {{ actionLabel || 'Change' }}
          }
          <ion-icon name="chevron-forward-outline" class="text-sm ml-0.5"></ion-icon>
        </span>
      }
    </div>
  `
})
export class BookingSummaryRowComponent {
    @Input() icon = 'location-outline';
    @Input() iconColor: 'orange' | 'blue' | 'green' | 'slate' = 'orange';
    @Input() title = '';
    @Input() value = '';
    @Input() emptyText = 'Not set';
    @Input() badge = '';
    @Input() subtitle = '';
    @Input() actionLabel = '';
    @Input() complete = false;
    @Input() disabled = false;
    @Input() hasError = false;
    @Input() ariaLabel = '';
    @Output() action = new EventEmitter<void>();

    constructor() {
        addIcons({
            locationOutline,
            pinOutline,
            storefrontOutline,
            checkmarkCircle,
            chevronForwardOutline,
            addOutline
        });
    }
}

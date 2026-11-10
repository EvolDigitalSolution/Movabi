import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
    chevronDownOutline,
    chevronUpOutline,
    listOutline,
    bagOutline,
    documentTextOutline,
    timeOutline,
    personOutline,
    cartOutline,
    cashOutline,
    cameraOutline,
    accessibilityOutline,
    informationCircleOutline,
    checkmarkCircle,
    alertCircleOutline
} from 'ionicons/icons';

@Component({
    selector: 'app-booking-accordion-section',
    standalone: true,
    imports: [CommonModule, IonicModule],
    template: `
    <div
      class="rounded-[20px] border overflow-hidden transition-all"
      [class.border-slate-200]="!hasError"
      [class.border-red-300]="hasError"
      [class.bg-white]="!disabled"
      [class.bg-slate-50]="disabled"
      [attr.aria-disabled]="disabled">

      <button
        type="button"
        (click)="!disabled && toggle()"
        [attr.aria-expanded]="expanded"
        [attr.aria-controls]="sectionId"
        [disabled]="disabled"
        class="w-full flex items-center gap-3 px-4 py-[18px] text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-500 focus-visible:outline-offset-2 min-h-[62px] disabled:opacity-50">

        <span
          class="w-[42px] h-[42px] rounded-[14px] flex items-center justify-center shrink-0 transition-colors"
          [class.bg-orange-50]="!hasError && !complete"
          [class.text-orange-500]="!hasError && !complete"
          [class.bg-emerald-50]="complete && !hasError"
          [class.text-emerald-600]="complete && !hasError"
          [class.bg-red-50]="hasError"
          [class.text-red-500]="hasError">
          <ion-icon [name]="resolvedIcon()" class="text-[22px]"></ion-icon>
        </span>

        <span class="flex-1 min-w-0">
          <span class="block text-sm font-black text-slate-900 leading-snug">{{ title }}</span>
          @if (summary && !expanded) {
            <span class="block text-xs font-semibold text-slate-500 truncate mt-0.5">{{ summary }}</span>
          }
        </span>

        <span class="flex items-center gap-2 shrink-0">
          @if (complete && !hasError) {
            <ion-icon name="checkmark-circle" class="text-emerald-500 text-[18px]"></ion-icon>
          }
          @if (hasError) {
            <ion-icon name="alert-circle-outline" class="text-red-500 text-[18px]"></ion-icon>
          }
          @if (!complete && !hasError) {
            <span class="px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-widest"
              [class.bg-slate-100]="!required"
              [class.text-slate-500]="!required"
              [class.bg-orange-50]="required"
              [class.text-orange-600]="required">
              {{ required ? 'Required' : 'Optional' }}
            </span>
          }
          <ion-icon
            [name]="expanded ? 'chevron-up-outline' : 'chevron-down-outline'"
            class="text-slate-400 text-[18px] transition-transform"
            [class.rotate-0]="!expanded">
          </ion-icon>
        </span>
      </button>

      @if (expanded && !disabled) {
        <div
          [id]="sectionId"
          class="px-4 pb-4 pt-1 border-t border-slate-100 animate-in fade-in slide-in-from-top-1 duration-150">
          <ng-content></ng-content>
        </div>
      }
    </div>
  `
})
export class BookingAccordionSectionComponent {
    @Input() title = '';
    @Input() icon = '';
    @Input() summary = '';
    @Input() expanded = false;
    @Input() complete = false;
    @Input() hasError = false;
    @Input() required = false;
    @Input() disabled = false;
    @Output() expandedChange = new EventEmitter<boolean>();

    readonly sectionId = 'accordion-' + Math.random().toString(36).slice(2, 8);

    private static readonly iconMap: Record<string, string> = {
        'shopping-details': 'list-outline',
        'items': 'bag-outline',
        'notes': 'document-text-outline',
        'notes-instructions': 'document-text-outline',
        'schedule': 'time-outline',
        'contact': 'person-outline',
        'contact-reference': 'person-outline',
        'items-list': 'cart-outline',
        'budget': 'cash-outline',
        'photos': 'camera-outline',
        'accessibility': 'accessibility-outline',
        'additional': 'information-circle-outline',
        'parcel': 'bag-outline',
        'handling': 'shield-checkmark-outline',
        'move-options': 'construct-outline',
        'property': 'home-outline',
        'vehicle': 'car-outline',
        'passengers': 'people-outline',
        'recipient': 'person-outline'
    };

    constructor() {
        addIcons({
            chevronDownOutline,
            chevronUpOutline,
            listOutline,
            bagOutline,
            documentTextOutline,
            timeOutline,
            personOutline,
            cartOutline,
            cashOutline,
            cameraOutline,
            accessibilityOutline,
            informationCircleOutline,
            checkmarkCircle,
            alertCircleOutline
        });
    }

    resolvedIcon(): string {
        if (this.icon) return this.icon;
        const key = this.title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z-]/g, '');
        return BookingAccordionSectionComponent.iconMap[key]
            || BookingAccordionSectionComponent.iconMap[this.title.toLowerCase().split(' ')[0]]
            || 'information-circle-outline';
    }

    toggle(): void {
        this.expanded = !this.expanded;
        this.expandedChange.emit(this.expanded);
    }
}

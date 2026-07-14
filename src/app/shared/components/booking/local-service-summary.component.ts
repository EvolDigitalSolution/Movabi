import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
    storefrontOutline,
    chevronForwardOutline,
    checkmarkCircle,
    gridOutline
} from 'ionicons/icons';

@Component({
    selector: 'app-local-service-summary',
    standalone: true,
    imports: [CommonModule, IonicModule],
    template: `
    <div
      class="flex items-center gap-3 min-h-[72px] px-4 py-3 rounded-[20px] border bg-white transition-all cursor-pointer active:scale-[0.99] shadow-sm"
      [class.border-emerald-200]="!!selectedProvider"
      [class.border-slate-200]="!selectedProvider"
      (click)="change.emit()"
      role="button"
      tabindex="0"
      [attr.aria-label]="ariaLabel || 'Change service provider'"
      (keydown.enter)="change.emit()"
      (keydown.space)="change.emit()">

      <span
        class="w-[46px] h-[46px] rounded-[14px] flex items-center justify-center shrink-0"
        [class.bg-emerald-50]="!!selectedProvider"
        [class.text-emerald-600]="!!selectedProvider"
        [class.bg-orange-50]="!selectedProvider"
        [class.text-orange-500]="!selectedProvider">
        <ion-icon [name]="selectedProvider ? 'checkmark-circle' : 'storefront-outline'" class="text-[22px]"></ion-icon>
      </span>

      <span class="flex-1 min-w-0">
        <span class="block text-[10px] font-black uppercase tracking-widest text-slate-400 leading-none mb-0.5">
          {{ categoryLabel || 'Service' }}
        </span>
        @if (selectedProvider) {
          <span class="block text-sm font-black text-slate-900 leading-snug truncate">{{ selectedProvider }}</span>
          @if (selectedCategory) {
            <span class="block text-xs font-semibold text-slate-500 mt-0.5 truncate">{{ selectedCategory }}</span>
          }
        } @else {
          <span class="block text-sm font-bold text-slate-400 leading-snug">{{ emptyText }}</span>
        }
      </span>

      <span class="shrink-0 px-3 py-2 rounded-full text-[10px] font-black uppercase tracking-widest bg-orange-50 text-orange-600">
        {{ selectedProvider ? 'Change' : 'Browse' }}
        <ion-icon name="chevron-forward-outline" class="text-sm ml-0.5 align-middle"></ion-icon>
      </span>
    </div>
  `
})
export class LocalServiceSummaryComponent {
    @Input() categoryLabel = 'Service';
    @Input() selectedCategory = '';
    @Input() selectedProvider = '';
    @Input() emptyText = 'Browse service providers';
    @Input() ariaLabel = '';
    @Output() change = new EventEmitter<void>();

    constructor() {
        addIcons({
            storefrontOutline,
            chevronForwardOutline,
            checkmarkCircle,
            gridOutline
        });
    }
}

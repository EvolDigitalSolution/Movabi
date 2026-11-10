import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';

export interface BookingSubtypeOption {
    id: string;
    label: string;
    icon: string;
    description?: string;
}

@Component({
    selector: 'app-booking-subtype-grid',
    standalone: true,
    imports: [CommonModule, IonicModule],
    template: `
    <div>
      @if (sectionLabel) {
        <div class="flex items-center justify-between mb-3 px-1">
          <p class="text-[10px] font-black uppercase tracking-widest text-slate-400">{{ sectionLabel }}</p>
          @if (showInfo) {
            <ion-icon name="information-circle-outline" class="text-slate-300 text-lg"></ion-icon>
          }
        </div>
      }

      <div
        class="grid gap-2"
        [class.grid-cols-3]="columns === 3"
        [class.grid-cols-2]="columns === 2">

        @for (option of options; track option.id) {
          <button
            type="button"
            (click)="select(option.id)"
            [attr.aria-pressed]="selected === option.id"
            class="flex flex-col items-center justify-center text-center gap-2 px-2 py-3.5 rounded-[18px] border transition-all active:scale-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-500 min-h-[104px]"
            [class.border-orange-400]="selected === option.id"
            [class.bg-orange-500]="selected === option.id && accentColor === 'orange'"
            [class.bg-blue-600]="selected === option.id && accentColor === 'blue'"
            [class.bg-emerald-600]="selected === option.id && accentColor === 'green'"
            [class.text-white]="selected === option.id"
            [class.shadow-md]="selected === option.id"
            [class.border-slate-200]="selected !== option.id"
            [class.bg-white]="selected !== option.id"
            [class.text-slate-600]="selected !== option.id">

            <ion-icon
              [name]="option.icon"
              class="text-[22px] shrink-0"
              [class.text-white]="selected === option.id"
              [class.text-slate-500]="selected !== option.id">
            </ion-icon>

            <span
              class="text-[10px] font-black uppercase tracking-wide leading-tight whitespace-normal text-center max-w-full">
              {{ option.label }}
            </span>

            @if (option.description) {
              <span
                class="text-[9px] font-semibold leading-tight opacity-70 text-center line-clamp-2">
                {{ option.description }}
              </span>
            }
          </button>
        }
      </div>
    </div>
  `
})
export class BookingSubtypeGridComponent {
    @Input() options: BookingSubtypeOption[] = [];
    @Input() selected = '';
    @Input() columns: 2 | 3 = 3;
    @Input() sectionLabel = '';
    @Input() showInfo = false;
    @Input() accentColor: 'orange' | 'blue' | 'green' = 'orange';
    @Output() selectedChange = new EventEmitter<string>();

    select(id: string): void {
        this.selectedChange.emit(id);
    }
}

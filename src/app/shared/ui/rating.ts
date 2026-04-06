import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';

@Component({
  selector: 'app-rating',
  template: `
    <div class="flex items-center gap-1.5">
      @if (rating && rating > 0) {
        <div class="flex items-center gap-0.5">
          @for (star of [1, 2, 3, 4, 5]; track star) {
            <ion-icon 
              [name]="star <= rating ? 'star' : 'star-outline'" 
              class="text-xs"
              [class.text-amber-400]="star <= rating"
              [class.text-slate-300]="star > rating"
            ></ion-icon>
          }
        </div>
        <span class="text-[10px] font-bold text-slate-500 uppercase tracking-widest ml-1">{{ rating | number:'1.1-1' }}</span>
      } @else {
        <div class="px-2 py-0.5 bg-blue-50 text-blue-600 rounded-full text-[8px] font-black uppercase tracking-widest border border-blue-100">
          New Driver
        </div>
      }
    </div>
  `,
  standalone: true,
  imports: [CommonModule, IonicModule]
})
export class RatingComponent {
  @Input() rating?: number;
}

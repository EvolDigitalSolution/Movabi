import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { addIcons } from 'ionicons';
import { navigate } from 'ionicons/icons';

@Component({
    selector: 'app-compact-booking-shell',
    standalone: true,
    imports: [CommonModule, IonicModule],
    template: `
    <div class="flex flex-col h-full">

      <div class="w-full relative z-10 shadow-lg"
        [style.height]="mapHeight">
        <ng-content select="[slot=map]"></ng-content>

        @if (routeDistanceKm !== null && routeDurationMins !== null) {
          <div class="absolute bottom-3 left-4 right-4 bg-white/95 backdrop-blur-xl p-4 rounded-2xl shadow-2xl border border-white/40 animate-in fade-in slide-in-from-bottom-6 pointer-events-none">
            <div class="flex items-center gap-4">
              <div class="w-11 h-11 rounded-2xl bg-blue-600 flex items-center justify-center text-white shadow-lg shadow-blue-200 shrink-0">
                <ion-icon name="navigate" class="text-xl"></ion-icon>
              </div>
              <div class="min-w-0">
                <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-0.5">Estimated Trip</p>
                <p class="text-base font-display font-bold text-slate-900">
                  {{ routeDistanceKm.toFixed(1) }} km &bull; {{ routeDurationMins.toFixed(0) }} mins
                </p>
              </div>
            </div>
          </div>
        }
      </div>

      <div
        class="flex-1 bg-white rounded-t-[2rem] -mt-4 relative z-20 shadow-[0_-20px_40px_-15px_rgba(0,0,0,0.1)] overflow-y-auto ion-padding-bottom">
        <div class="px-5 pt-5 pb-8 max-w-2xl mx-auto">
          <ng-content></ng-content>
        </div>
      </div>
    </div>
  `
})
export class CompactBookingShellComponent {
    @Input() mapHeight = '33vh';
    @Input() routeDistanceKm: number | null = null;
    @Input() routeDurationMins: number | null = null;

    constructor() {
        addIcons({ navigate });
    }
}

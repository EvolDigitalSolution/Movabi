import { CommonModule } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { OnboardingTourService } from '../../core/services/onboarding-tour/onboarding-tour.service';

@Component({
  selector: 'app-movabi-tour-overlay',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (tour(); as active) {
      <div class="fixed inset-0 z-[12000] bg-slate-950/45 px-4 py-8 flex items-end sm:items-center justify-center">
        <div class="w-full max-w-sm rounded-[1.5rem] bg-white shadow-2xl border border-slate-100 p-5">
          <div class="flex items-start justify-between gap-4">
            <div>
              <p class="text-[10px] font-black uppercase tracking-[0.16em] text-amber-600">
                Step {{ active.index + 1 }} of {{ active.steps.length }}
              </p>
              <h2 class="mt-2 text-lg font-display font-black text-slate-950 leading-tight">
                {{ step().title }}
              </h2>
            </div>
            <button type="button" (click)="tourService.skip()" class="text-xs font-black text-slate-400 uppercase tracking-widest">
              Skip
            </button>
          </div>

          <p class="mt-3 text-sm font-semibold leading-6 text-slate-600">
            {{ step().body }}
          </p>

          <div class="mt-5 h-1.5 rounded-full bg-slate-100 overflow-hidden">
            <div class="h-full rounded-full bg-amber-500 transition-all" [style.width.%]="progress()"></div>
          </div>

          <div class="mt-5 flex gap-3">
            <button type="button" (click)="tourService.skip()" class="flex-1 h-11 rounded-xl border border-slate-200 bg-white text-sm font-black text-slate-600">
              Skip
            </button>
            <button type="button" (click)="tourService.next()" class="flex-1 h-11 rounded-xl bg-amber-500 text-sm font-black text-slate-950 shadow-lg shadow-amber-500/20">
              {{ active.index === active.steps.length - 1 ? 'Finish' : 'Next' }}
            </button>
          </div>
        </div>
      </div>
    }
  `
})
export class MovabiTourOverlayComponent {
  readonly tourService = inject(OnboardingTourService);
  readonly tour = this.tourService.activeTour;
  readonly step = computed(() => {
    const tour = this.tour();
    return tour?.steps[tour.index] || { title: '', body: '' };
  });
  readonly progress = computed(() => {
    const tour = this.tour();
    if (!tour?.steps.length) return 0;
    return ((tour.index + 1) / tour.steps.length) * 100;
  });
}

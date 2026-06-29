import { CommonModule } from '@angular/common';
import { Component, Input, OnChanges, OnDestroy, SimpleChanges } from '@angular/core';

export type MovabiCarouselSlide = {
  eyebrow?: string;
  title: string;
  description?: string;
  value?: string;
  tone?: 'amber' | 'slate' | 'emerald' | 'blue' | 'rose';
};

@Component({
  selector: 'app-movabi-carousel',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (slides.length > 0) {
      <section class="relative overflow-hidden rounded-[1.5rem] border border-slate-200 bg-white shadow-lg shadow-slate-900/10">
        <div
          class="flex transition-transform duration-500 ease-out"
          [style.transform]="'translateX(-' + (activeIndex * 100) + '%)'"
        >
          @for (slide of slides; track $index) {
            <article class="min-w-full p-4 sm:p-5" [ngClass]="toneClass(slide.tone)">
              <div class="flex items-start justify-between gap-4">
                <div class="min-w-0">
                  @if (slide.eyebrow) {
                    <p class="movabi-card-label text-white/75">{{ slide.eyebrow }}</p>
                  }
                  <h3 class="mt-2 text-lg sm:text-xl font-display font-black leading-tight text-white">
                    {{ slide.title }}
                  </h3>
                  @if (slide.description) {
                    <p class="mt-2 text-sm font-semibold leading-snug text-white/80">
                      {{ slide.description }}
                    </p>
                  }
                </div>

                @if (slide.value) {
                  <div class="shrink-0 rounded-2xl bg-white/15 px-3 py-2 text-right">
                    <p class="text-lg font-display font-black text-white leading-none">{{ slide.value }}</p>
                  </div>
                }
              </div>
            </article>
          }
        </div>

        @if (slides.length > 1) {
          <div class="absolute bottom-3 left-0 right-0 flex justify-center gap-2">
            @for (slide of slides; track $index) {
              <button
                type="button"
                class="h-2 rounded-full bg-white/50 transition-all"
                [class.w-6]="activeIndex === $index"
                [class.w-2]="activeIndex !== $index"
                [attr.aria-label]="'Show carousel slide ' + ($index + 1)"
                (click)="setActive($index)"
              ></button>
            }
          </div>
        }
      </section>
    }
  `
})
export class MovabiCarouselComponent implements OnChanges, OnDestroy {
  @Input() slides: MovabiCarouselSlide[] = [];

  activeIndex = 0;
  private timer?: ReturnType<typeof setInterval>;
  private paused = false;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['slides']) {
      this.activeIndex = 0;
      this.resetTimer();
    }
  }

  ngOnDestroy(): void {
    this.clearTimer();
  }

  setActive(index: number): void {
    if (!this.slides.length) return;

    this.paused = true;
    this.activeIndex = Math.max(0, Math.min(index, this.slides.length - 1));
    window.setTimeout(() => {
      this.paused = false;
    }, 8000);
  }

  toneClass(tone: MovabiCarouselSlide['tone'] = 'amber'): string {
    const tones = {
      amber: 'bg-gradient-to-br from-amber-500 to-orange-600',
      slate: 'bg-gradient-to-br from-slate-950 to-slate-800',
      emerald: 'bg-gradient-to-br from-emerald-600 to-teal-700',
      blue: 'bg-gradient-to-br from-sky-600 to-blue-700',
      rose: 'bg-gradient-to-br from-rose-600 to-orange-600'
    };

    return tones[tone || 'amber'];
  }

  private resetTimer(): void {
    this.clearTimer();
    if (this.slides.length <= 1) return;

    this.timer = setInterval(() => {
      if (this.paused || this.slides.length <= 1) return;
      this.activeIndex = (this.activeIndex + 1) % this.slides.length;
    }, 5000);
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

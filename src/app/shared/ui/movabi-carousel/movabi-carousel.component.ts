import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  Input,
  NgZone,
  OnChanges,
  OnDestroy,
  OnInit,
  SimpleChanges,
  inject
} from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  bagHandleOutline,
  carSportOutline,
  cubeOutline,
  documentTextOutline,
  locationOutline,
  shieldCheckmarkOutline,
  starOutline,
  storefrontOutline,
  walletOutline
} from 'ionicons/icons';

export type MovabiCarouselSlide = {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  description?: string;
  value?: string;
  icon?: string;
  imageUrl?: string;
  gradient?: string;
  accentColor?: string;
  cta?: string;
  tone?: 'amber' | 'slate' | 'emerald' | 'blue' | 'rose';
};

@Component({
  selector: 'app-movabi-carousel',
  standalone: true,
  imports: [CommonModule, IonIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (slides.length > 0) {
      <section class="relative overflow-hidden rounded-[1.5rem] border border-slate-200 bg-white shadow-lg shadow-slate-900/10">
        <div
          class="flex transition-transform duration-500 ease-out"
          [style.transform]="'translateX(-' + (activeIndex * 100) + '%)'"
        >
          @for (slide of slides; track $index) {
            <article class="relative min-w-full overflow-hidden p-4 sm:p-5 min-h-[172px]" [ngClass]="toneClass(slide)">
              <div class="absolute -right-10 -top-10 h-40 w-40 rounded-full bg-white/15"></div>
              <div class="absolute right-5 bottom-4 h-16 w-32 rounded-full border-2 border-white/20 rotate-[-18deg]"></div>
              <div class="absolute right-9 bottom-11 h-1.5 w-28 rounded-full bg-white/25 rotate-[-18deg]"></div>

              <div class="relative z-10 flex min-h-[140px] items-start justify-between gap-4">
                <div class="min-w-0 max-w-[68%]">
                  @if (slide.eyebrow) {
                    <p class="text-[10px] font-black uppercase tracking-[0.16em] text-white/85">{{ slide.eyebrow }}</p>
                  }
                  <h3 class="mt-2 text-lg sm:text-xl font-display font-black leading-tight text-white drop-shadow-sm">
                    {{ slide.title }}
                  </h3>
                  @if (slide.subtitle || slide.description) {
                    <p class="mt-2 text-sm font-semibold leading-snug text-white/90">
                      {{ slide.subtitle || slide.description }}
                    </p>
                  }
                  @if (slide.cta) {
                    <p class="mt-3 inline-flex rounded-full bg-white/18 px-3 py-1 text-[10px] font-black uppercase tracking-[0.12em] text-white">
                      {{ slide.cta }}
                    </p>
                  }
                </div>

                <div class="relative shrink-0 self-end">
                  @if (slide.imageUrl) {
                    <img [src]="slide.imageUrl" alt="" class="h-24 w-24 rounded-[1.5rem] object-cover shadow-xl shadow-slate-900/20" />
                  } @else {
                    <div class="relative h-24 w-24 rounded-[1.65rem] bg-white/18 border border-white/20 shadow-xl shadow-slate-900/15 backdrop-blur flex items-center justify-center">
                      <div class="absolute inset-3 rounded-full border border-white/20"></div>
                      <ion-icon [name]="slide.icon || fallbackIcon(slide.tone)" class="text-[3rem] text-white drop-shadow"></ion-icon>
                    </div>
                  }

                  @if (slide.value) {
                    <div class="absolute -left-5 -top-3 shrink-0 rounded-2xl bg-white/95 px-3 py-2 text-right shadow-lg shadow-slate-900/15">
                      <p class="text-sm font-display font-black leading-none" [style.color]="slide.accentColor || '#0f172a'">{{ slide.value }}</p>
                    </div>
                  }
                </div>
              </div>
            </article>
          }
        </div>

        @if (slides.length > 1) {
          <div class="absolute bottom-3 left-0 right-0 flex justify-center gap-2">
            @for (slide of slides; track $index) {
              <button
                type="button"
                class="h-2 rounded-full bg-white/60 shadow-sm ring-1 ring-black/5 transition-all"
                [class.w-6]="activeIndex === $index"
                [class.w-2]="activeIndex !== $index"
                [class.bg-white]="activeIndex === $index"
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
export class MovabiCarouselComponent implements OnInit, OnChanges, OnDestroy {
  @Input() slides: MovabiCarouselSlide[] = [];

  activeIndex = 0;
  private timer?: ReturnType<typeof setInterval>;
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly zone = inject(NgZone);
  private readonly reducedMotion = typeof window !== 'undefined'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

  constructor() {
    addIcons({
      bagHandleOutline,
      carSportOutline,
      cubeOutline,
      documentTextOutline,
      locationOutline,
      shieldCheckmarkOutline,
      starOutline,
      storefrontOutline,
      walletOutline
    });
  }

  ngOnInit(): void {
    this.resetTimer();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['slides']) {
      this.activeIndex = 0;
      this.resetTimer();
      this.cdr.markForCheck();
    }
  }

  ngOnDestroy(): void {
    this.clearTimer();
  }

  setActive(index: number): void {
    if (!this.slides.length) return;

    this.activeIndex = Math.max(0, Math.min(index, this.slides.length - 1));
    this.resetTimer();
    this.cdr.markForCheck();
  }

  toneClass(slide: MovabiCarouselSlide): string {
    if (slide.gradient) return slide.gradient;

    const tones = {
      amber: 'bg-gradient-to-br from-orange-500 via-amber-500 to-yellow-500',
      slate: 'bg-gradient-to-br from-slate-950 via-slate-900 to-slate-700',
      emerald: 'bg-gradient-to-br from-emerald-600 via-teal-600 to-cyan-700',
      blue: 'bg-gradient-to-br from-sky-600 via-blue-700 to-indigo-800',
      rose: 'bg-gradient-to-br from-rose-600 via-orange-600 to-amber-600'
    };

    return tones[slide.tone || 'amber'];
  }

  fallbackIcon(tone: MovabiCarouselSlide['tone'] = 'amber'): string {
    const icons = {
      amber: 'car-sport-outline',
      slate: 'shield-checkmark-outline',
      emerald: 'bag-handle-outline',
      blue: 'cube-outline',
      rose: 'star-outline'
    };

    return icons[tone || 'amber'];
  }

  private resetTimer(): void {
    this.clearTimer();
    if (this.slides.length <= 1 || this.reducedMotion?.matches) return;

    this.zone.runOutsideAngular(() => {
      this.timer = setInterval(() => {
        this.zone.run(() => {
          if (this.slides.length <= 1) return;
          this.activeIndex = (this.activeIndex + 1) % this.slides.length;
          this.cdr.markForCheck();
        });
      }, 4500);
    });
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

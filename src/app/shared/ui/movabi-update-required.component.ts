import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { carSport, refreshOutline, downloadOutline, closeOutline } from 'ionicons/icons';
import { AppVersionService } from '../../core/services/app-version.service';

@Component({
  selector: 'app-movabi-update-required',
  standalone: true,
  imports: [CommonModule, IonIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (version.shouldShowUpdate()) {
      <div class="fixed inset-0 z-[12000] bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4">
        <section class="w-full max-w-md rounded-[1.75rem] bg-white shadow-2xl border border-white/80 overflow-hidden">
          <div class="p-5 bg-slate-950 text-white">
            <div class="flex items-start justify-between gap-4">
              <div class="flex items-center gap-3">
                <div class="w-12 h-12 rounded-2xl bg-amber-500 text-slate-950 flex items-center justify-center shadow-lg">
                  <ion-icon name="car-sport" class="text-2xl"></ion-icon>
                </div>
                <div>
                  <p class="text-[11px] uppercase tracking-[0.22em] text-amber-200 font-black">Movabi Update</p>
                  <h2 class="text-xl font-black leading-tight">{{ version.updateState().title }}</h2>
                </div>
              </div>

              @if (canClose()) {
                <button type="button" (click)="version.dismiss()" class="w-9 h-9 rounded-xl bg-white/10 flex items-center justify-center">
                  <ion-icon name="close-outline"></ion-icon>
                </button>
              }
            </div>
          </div>

          <div class="p-5 space-y-4">
            <p class="text-sm font-semibold text-slate-700 leading-relaxed">
              {{ version.updateState().message }}
            </p>

            @if (version.updateState().releaseNotes) {
              <div class="rounded-2xl bg-slate-50 border border-slate-100 p-4">
                <p class="text-[11px] uppercase tracking-[0.18em] text-slate-500 font-black mb-2">Release Notes</p>
                <p class="text-sm text-slate-700 font-medium whitespace-pre-line">{{ version.updateState().releaseNotes }}</p>
              </div>
            }

            <div class="grid grid-cols-2 gap-3">
              <div class="rounded-2xl bg-slate-50 border border-slate-100 p-3">
                <p class="text-[10px] uppercase tracking-[0.18em] text-slate-400 font-black">Your version</p>
                <p class="text-base font-black text-slate-950">{{ version.updateState().localVersion }}</p>
              </div>
              <div class="rounded-2xl bg-amber-50 border border-amber-100 p-3">
                <p class="text-[10px] uppercase tracking-[0.18em] text-amber-700 font-black">Required</p>
                <p class="text-base font-black text-slate-950">{{ version.updateState().minimumVersion }}</p>
              </div>
            </div>

            <button type="button" (click)="version.performUpdateAction()" class="w-full h-12 rounded-2xl bg-amber-500 text-slate-950 font-black shadow-lg shadow-amber-500/25 flex items-center justify-center gap-2">
              <ion-icon [name]="version.updateState().platform === 'web' ? 'refresh-outline' : 'download-outline'"></ion-icon>
              {{ version.updateState().platform === 'web' ? 'Refresh Now' : 'Update App' }}
            </button>

            @if (canClose()) {
              <button type="button" (click)="version.dismiss()" class="w-full h-11 rounded-2xl bg-slate-100 text-slate-700 font-black">
                Later
              </button>
            }
          </div>
        </section>
      </div>
    }
  `
})
export class MovabiUpdateRequiredComponent {
  readonly version = inject(AppVersionService);

  constructor() {
    addIcons({ carSport, refreshOutline, downloadOutline, closeOutline });
  }

  canClose(): boolean {
    const state = this.version.updateState();
    return state.canDismiss && !state.updateRequired && state.severity !== 'required' && state.severity !== 'critical';
  }
}

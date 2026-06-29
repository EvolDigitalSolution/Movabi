import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';

export type PerformanceType = 'top-rated' | 'reliable' | 'fast-responder' | 'pro-driver';

@Component({
  selector: 'app-performance-badge',
  standalone: true,
  imports: [CommonModule, IonicModule],
  template: `
    <div [class]="containerClasses">
      <ion-icon [name]="icon" [class]="iconClasses" class="mr-1.5 text-sm"></ion-icon>
      <span class="text-[10px] font-bold uppercase tracking-[0.08em] whitespace-nowrap">{{ label }}</span>
    </div>
  `
})
export class PerformanceBadgeComponent {
  @Input() type: PerformanceType = 'pro-driver';

  get icon(): string {
    switch (this.type) {
      case 'top-rated': return 'star';
      case 'reliable': return 'shield-checkmark';
      case 'fast-responder': return 'flash';
      case 'pro-driver': return 'ribbon';
      default: return 'ribbon';
    }
  }

  get label(): string {
    switch (this.type) {
      case 'top-rated': return 'Top Rated';
      case 'reliable': return 'Reliable';
      case 'fast-responder': return 'Fast Responder';
      case 'pro-driver': return 'Pro Driver';
      default: return 'Pro';
    }
  }

  get containerClasses(): string {
    switch (this.type) {
      case 'top-rated': return 'movabi-badge-sm bg-amber-50 text-amber-600 border-amber-100';
      case 'reliable': return 'movabi-badge-sm bg-emerald-50 text-emerald-600 border-emerald-100';
      case 'fast-responder': return 'movabi-badge-sm bg-blue-50 text-blue-600 border-blue-100';
      case 'pro-driver': return 'movabi-badge-sm bg-indigo-50 text-indigo-600 border-indigo-100';
      default: return 'movabi-badge-sm bg-slate-50 text-slate-600 border-slate-100';
    }
  }

  get iconClasses(): string {
    switch (this.type) {
      case 'top-rated': return 'text-amber-500';
      case 'reliable': return 'text-emerald-500';
      case 'fast-responder': return 'text-blue-500';
      case 'pro-driver': return 'text-indigo-500';
      default: return 'text-slate-500';
    }
  }
}

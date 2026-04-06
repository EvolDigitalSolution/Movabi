import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-badge',
  standalone: true,
  imports: [CommonModule],
  template: `
    <span
      class="inline-flex items-center px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest border"
      [class]="badgeClasses"
    >
      <ng-content></ng-content>
    </span>
  `
})
export class BadgeComponent {
  @Input() variant: 'primary' | 'secondary' | 'success' | 'error' | 'warning' | 'info' = 'primary';

  get badgeClasses(): string {
    const variants = {
      primary: 'bg-blue-50 text-blue-600 border-blue-100',
      secondary: 'bg-slate-50 text-slate-600 border-slate-100',
      success: 'bg-emerald-50 text-emerald-600 border-emerald-100',
      error: 'bg-red-50 text-red-600 border-red-100',
      warning: 'bg-amber-50 text-amber-600 border-amber-100',
      info: 'bg-indigo-50 text-indigo-600 border-indigo-100'
    };

    return variants[this.variant];
  }
}

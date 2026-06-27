import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-card',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div 
      class="bg-white rounded-[1.35rem] sm:rounded-3xl p-4 sm:p-5 md:p-6 shadow-sm shadow-slate-900/7 border border-slate-200 transition-all duration-500 min-w-0"
      [class.hover:shadow-xl]="hoverable"
      [class.hover:shadow-blue-600/5]="hoverable"
      [class.hover:-translate-y-1]="hoverable"
      [class.cursor-pointer]="hoverable"
    >
      @if (title) {
        <div class="mb-4 sm:mb-5 flex items-center justify-between gap-3 min-w-0">
          <h3 class="text-lg sm:text-xl font-display font-bold text-slate-900 tracking-tight leading-tight min-w-0">{{ title }}</h3>
          <ng-content select="[header-action]"></ng-content>
        </div>
      }
      <ng-content></ng-content>
      @if (hasFooter) {
        <div class="mt-4 sm:mt-5 pt-4 sm:pt-5 border-t border-slate-50">
          <ng-content select="[footer]"></ng-content>
        </div>
      }
    </div>
  `
})
export class CardComponent {
  @Input() title?: string;
  @Input() hoverable = false;
  @Input() hasFooter = false;
}

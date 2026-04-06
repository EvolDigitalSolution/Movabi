import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-card',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div 
      class="bg-white rounded-3xl p-6 md:p-8 shadow-sm border border-slate-100 transition-all duration-500"
      [class.hover:shadow-xl]="hoverable"
      [class.hover:shadow-blue-600/5]="hoverable"
      [class.hover:-translate-y-1]="hoverable"
      [class.cursor-pointer]="hoverable"
    >
      @if (title) {
        <div class="mb-6 flex items-center justify-between">
          <h3 class="text-xl font-display font-bold text-slate-900 tracking-tight">{{ title }}</h3>
          <ng-content select="[header-action]"></ng-content>
        </div>
      }
      <ng-content></ng-content>
      @if (hasFooter) {
        <div class="mt-6 pt-6 border-t border-slate-50">
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

import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-card',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div
      class="movabi-card transition-all duration-300 min-w-0"
      [class.hover:shadow-xl]="hoverable"
      [class.hover:shadow-blue-600/5]="hoverable"
      [class.hover:-translate-y-1]="hoverable"
      [class.cursor-pointer]="hoverable"
    >
      @if (title) {
        <div class="mb-3 flex items-center justify-between gap-3 min-w-0">
          <h3 class="movabi-card-title min-w-0">{{ title }}</h3>
          <ng-content select="[header-action]"></ng-content>
        </div>
      }
      <ng-content></ng-content>
      @if (hasFooter) {
        <div class="mt-3 pt-3 border-t border-slate-100">
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

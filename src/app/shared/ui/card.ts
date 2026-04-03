import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-card',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div 
      class="bg-white rounded-2xl p-4 md:p-6 shadow-sm border border-gray-100 transition-all duration-300"
      [class.hover:shadow-md]="hoverable"
      [class.cursor-pointer]="hoverable"
    >
      <div *ngIf="title" class="mb-4 flex items-center justify-between">
        <h3 class="text-lg font-bold text-text-primary">{{ title }}</h3>
        <ng-content select="[header-action]"></ng-content>
      </div>
      <ng-content></ng-content>
      <div *ngIf="hasFooter" class="mt-4 pt-4 border-t border-gray-50">
        <ng-content select="[footer]"></ng-content>
      </div>
    </div>
  `
})
export class CardComponent {
  @Input() title?: string;
  @Input() hoverable = false;
  @Input() hasFooter = false;
}

import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { ButtonComponent } from './button';

@Component({
  selector: 'app-empty-state',
  template: `
    <div class="flex flex-col items-center justify-center p-6 sm:p-8 text-center animate-in fade-in zoom-in duration-500">
      <div class="movabi-icon-chip mb-4">
        <ion-icon [name]="icon" class="text-2xl"></ion-icon>
      </div>
      <h3 class="movabi-card-title mb-2">{{ title }}</h3>
      <p class="movabi-card-subtitle max-w-xs mx-auto mb-5">{{ description }}</p>
      
      @if (actionLabel) {
        <app-button (click)="action.emit()" size="md" class="px-8">
          {{ actionLabel }}
        </app-button>
      }
    </div>
  `,
  standalone: true,
  imports: [CommonModule, IonicModule, ButtonComponent]
})
export class EmptyStateComponent {
  @Input() icon = 'document-text-outline';
  @Input() title = 'No data found';
  @Input() description = 'There is nothing to display at the moment.';
  @Input() actionLabel?: string;
  @Output() action = new EventEmitter<void>();
}

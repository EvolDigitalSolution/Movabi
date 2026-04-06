import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { ButtonComponent } from './button';

@Component({
  selector: 'app-empty-state',
  template: `
    <div class="flex flex-col items-center justify-center p-12 text-center animate-in fade-in zoom-in duration-500">
      <div class="w-24 h-24 rounded-[2rem] bg-slate-50 flex items-center justify-center mb-6 border border-slate-100 shadow-sm">
        <ion-icon [name]="icon" class="text-4xl text-slate-300"></ion-icon>
      </div>
      <h3 class="text-xl font-display font-bold text-slate-900 mb-2">{{ title }}</h3>
      <p class="text-slate-500 max-w-xs mx-auto mb-8 text-sm leading-relaxed">{{ description }}</p>
      
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

import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';

@Component({
  selector: 'app-button',
  standalone: true,
  imports: [CommonModule, IonicModule],
  template: `
    <button
      [type]="type"
      [disabled]="disabled || loading"
      (click)="onClick.emit($event)"
      [class]="buttonClasses"
    >
      <div class="flex items-center justify-center gap-2">
        <ion-spinner *ngIf="loading" name="crescent" size="small"></ion-spinner>
        <ng-content></ng-content>
      </div>
    </button>
  `,
  styles: [`
    :host {
      display: block;
      width: 100%;
    }
  `]
})
export class ButtonComponent {
  @Input() variant: 'primary' | 'secondary' | 'danger' | 'ghost' = 'primary';
  @Input() size: 'sm' | 'md' | 'lg' = 'md';
  @Input() type: 'button' | 'submit' = 'button';
  @Input() disabled = false;
  @Input() loading = false;
  @Input() fullWidth = true;

  @Output() onClick = new EventEmitter<MouseEvent>();

  get buttonClasses(): string {
    const base = 'inline-flex items-center justify-center rounded-xl font-semibold transition-all duration-200 active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none focus:outline-none focus:ring-2 focus:ring-offset-2';
    
    const variants = {
      primary: 'bg-primary text-white hover:bg-primary-dark focus:ring-primary/50',
      secondary: 'bg-white text-secondary border border-gray-200 hover:bg-gray-50 focus:ring-gray-200',
      danger: 'bg-error text-white hover:bg-red-600 focus:ring-error/50',
      ghost: 'bg-transparent text-text-secondary hover:bg-gray-100 focus:ring-gray-100'
    };

    const sizes = {
      sm: 'px-3 py-1.5 text-sm',
      md: 'px-6 py-3 text-base',
      lg: 'px-8 py-4 text-lg'
    };

    return `${base} ${variants[this.variant]} ${sizes[this.size]} ${this.fullWidth ? 'w-full' : ''}`;
  }
}

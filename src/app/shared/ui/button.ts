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
      (click)="clicked.emit($event)"
      [class]="buttonClasses"
    >
      <div class="flex items-center justify-center gap-2">
        @if (loading) {
          <ion-spinner name="crescent" size="small"></ion-spinner>
        }
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
  @Input() variant: 'primary' | 'secondary' | 'error' | 'ghost' | 'outline' = 'primary';
  @Input() size: 'sm' | 'md' | 'lg' = 'md';
  @Input() type: 'button' | 'submit' = 'button';
  @Input() disabled = false;
  @Input() loading = false;
  @Input() fullWidth = true;

  @Output() clicked = new EventEmitter<MouseEvent>();

  get buttonClasses(): string {
    const base = 'inline-flex items-center justify-center rounded-2xl font-bold transition-all duration-300 active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none focus:outline-none focus:ring-4';
    
    const variants = {
      primary: 'bg-blue-600 text-white hover:bg-blue-700 shadow-lg shadow-blue-600/20 focus:ring-blue-500/20',
      secondary: 'bg-white text-slate-900 border border-slate-200 hover:bg-slate-50 hover:border-slate-300 focus:ring-slate-200/50',
      error: 'bg-red-600 text-white hover:bg-red-600 shadow-lg shadow-red-600/20 focus:ring-red-500/20',
      ghost: 'bg-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus:ring-slate-100',
      outline: 'bg-white text-slate-900 border border-slate-200 hover:bg-slate-50 hover:border-slate-300 shadow-sm focus:ring-slate-200/50'
    };

    const sizes = {
      sm: 'px-4 py-2 text-xs uppercase tracking-widest',
      md: 'px-6 py-3.5 text-sm',
      lg: 'px-8 py-4.5 text-base'
    };

    return `${base} ${variants[this.variant]} ${sizes[this.size]} ${this.fullWidth ? 'w-full' : ''}`;
  }
}

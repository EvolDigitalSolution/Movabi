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
  @Input() color: 'primary' | 'error' | 'success' | 'warning' = 'primary';
  @Input() size: 'sm' | 'md' | 'lg' = 'md';
  @Input() type: 'button' | 'submit' = 'button';
  @Input() disabled = false;
  @Input() loading = false;
  @Input() fullWidth = true;

  @Output() clicked = new EventEmitter<MouseEvent>();

  get buttonClasses(): string {
    const base = 'inline-flex items-center justify-center rounded-2xl font-black transition-all duration-300 active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none disabled:shadow-none focus:outline-none focus:ring-4';

    const variants = {
      primary: 'bg-blue-600 text-white hover:bg-blue-700 shadow-xl shadow-blue-600/25 focus:ring-blue-500/20',
      secondary: 'bg-white text-slate-950 border-2 border-slate-200 hover:bg-slate-50 hover:border-slate-300 shadow-md shadow-slate-200/60 focus:ring-slate-200/50',
      error: 'bg-red-600 text-white hover:bg-red-700 shadow-xl shadow-red-600/25 focus:ring-red-500/20',
      ghost: 'bg-transparent text-slate-600 hover:bg-slate-100 hover:text-slate-950 focus:ring-slate-100',
      outline: 'bg-white text-slate-950 border-2 border-slate-200 hover:bg-slate-50 hover:border-slate-300 shadow-md shadow-slate-200/60 focus:ring-slate-200/50'
    };

    const colorOverrides = {
      primary: '',
      success: 'bg-emerald-600 text-white hover:bg-emerald-700 border-emerald-600 shadow-xl shadow-emerald-600/25 focus:ring-emerald-500/20',
      warning: 'bg-amber-500 text-slate-950 hover:bg-amber-400 border-amber-500 shadow-xl shadow-amber-500/25 focus:ring-amber-400/20',
      error: this.variant === 'outline' || this.variant === 'secondary'
        ? 'bg-white text-red-700 border-2 border-red-200 hover:bg-red-50 hover:border-red-300 shadow-md shadow-red-100/70 focus:ring-red-500/20'
        : 'bg-red-600 text-white hover:bg-red-700 border-red-600 shadow-xl shadow-red-600/25 focus:ring-red-500/20'
    };

    const sizes = {
      sm: 'min-h-11 px-5 py-2.5 text-xs uppercase tracking-[0.12em]',
      md: 'min-h-[3.25rem] px-6 py-3.5 text-sm',
      lg: 'min-h-[3.75rem] px-8 py-4 text-base'
    };

    return `${base} ${variants[this.variant]} ${colorOverrides[this.color]} ${sizes[this.size]} ${this.fullWidth ? 'w-full' : ''}`;
  }
}

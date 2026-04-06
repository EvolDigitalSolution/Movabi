import { Component, Input, forwardRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { ControlValueAccessor, NG_VALUE_ACCESSOR, ReactiveFormsModule } from '@angular/forms';

@Component({
  selector: 'app-input',
  standalone: true,
  imports: [CommonModule, IonicModule, ReactiveFormsModule],
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => InputComponent),
      multi: true
    }
  ],
  template: `
    <div class="mb-5">
      @if (label) {
        <label [for]="id" class="block text-xs font-bold text-slate-500 uppercase tracking-widest mb-2 ml-1">
          {{ label }}
        </label>
      }
      <div class="relative group">
        @if (icon) {
          <ion-icon 
            [name]="icon" 
            class="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-xl group-focus-within:text-blue-600 transition-colors"
          ></ion-icon>
        }
        <input
          [id]="id"
          [type]="type"
          [placeholder]="placeholder"
          [value]="value"
          [disabled]="disabled"
          (input)="onInput($event)"
          (blur)="onBlur()"
          class="w-full bg-white border border-slate-200 rounded-2xl py-4 focus:outline-none focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 transition-all duration-300 text-slate-900 font-medium placeholder:text-slate-400"
          [class.pl-12]="icon && !phoneCode"
          [class.pl-24]="icon && phoneCode"
          [class.pl-16]="!icon && phoneCode"
          [class.px-5]="!icon && !phoneCode"
          [class.border-red-500]="error"
          [class.focus:ring-red-500/10]="error"
          [class.focus:border-red-500]="error"
        />
        @if (phoneCode && type === 'tel') {
          <div class="absolute left-12 top-1/2 -translate-y-1/2 text-slate-400 font-bold text-sm border-r border-slate-100 pr-3 h-6 flex items-center" [class.left-12]="icon" [class.left-4]="!icon">
            {{ phoneCode }}
          </div>
        }
      </div>
      @if (error) {
        <p class="mt-2 text-xs text-red-500 ml-1 font-medium flex items-center animate-in fade-in slide-in-from-top-1 duration-200">
          <ion-icon name="alert-circle-outline" class="mr-1.5 text-sm"></ion-icon>
          {{ error }}
        </p>
      }
    </div>
  `
})
export class InputComponent implements ControlValueAccessor {
  @Input() label?: string;
  @Input() placeholder = '';
  @Input() type: 'text' | 'email' | 'password' | 'number' | 'tel' = 'text';
  @Input() icon?: string;
  @Input() phoneCode?: string;
  @Input() error?: string;
  @Input() disabled = false;
  @Input() id = 'input-' + Math.random().toString(36).substring(2, 9);

  value: string | number = '';

  onChange: (value: string | number) => void = () => { /* empty */ };
  onTouched: () => void = () => { /* empty */ };

  writeValue(value: string | number): void {
    this.value = value;
  }

  registerOnChange(fn: (value: string | number) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled = isDisabled;
  }

  onInput(event: Event): void {
    const val = (event.target as HTMLInputElement).value;
    this.value = val;
    this.onChange(val);
  }

  onBlur(): void {
    this.onTouched();
  }
}

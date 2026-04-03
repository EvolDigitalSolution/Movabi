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
    <div class="mb-4">
      <label *ngIf="label" class="block text-sm font-semibold text-text-primary mb-1.5 ml-1">
        {{ label }}
      </label>
      <div class="relative group">
        <ion-icon 
          *ngIf="icon" 
          [name]="icon" 
          class="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 text-xl group-focus-within:text-primary transition-colors"
        ></ion-icon>
        <input
          [type]="type"
          [placeholder]="placeholder"
          [value]="value"
          [disabled]="disabled"
          (input)="onInput($event)"
          (blur)="onBlur()"
          class="w-full bg-white border border-gray-200 rounded-xl py-3.5 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all duration-200 text-text-primary placeholder:text-gray-400"
          [class.pl-12]="icon"
          [class.px-4]="!icon"
          [class.border-error]="error"
        />
      </div>
      <p *ngIf="error" class="mt-1.5 text-xs text-error ml-1 font-medium flex items-center">
        <ion-icon name="alert-circle" class="mr-1"></ion-icon>
        {{ error }}
      </p>
    </div>
  `
})
export class InputComponent implements ControlValueAccessor {
  @Input() label?: string;
  @Input() placeholder = '';
  @Input() type: 'text' | 'email' | 'password' | 'number' | 'tel' = 'text';
  @Input() icon?: string;
  @Input() error?: string;
  @Input() disabled = false;

  value: any = '';

  onChange: any = () => {};
  onTouched: any = () => {};

  writeValue(value: any): void {
    this.value = value;
  }

  registerOnChange(fn: any): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: any): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled = isDisabled;
  }

  onInput(event: any): void {
    const val = event.target.value;
    this.value = val;
    this.onChange(val);
  }

  onBlur(): void {
    this.onTouched();
  }
}

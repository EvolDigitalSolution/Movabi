import { Component, Input, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { AppConfigService } from '@core/services/config/app-config.service';

@Component({
  selector: 'app-price-display',
  standalone: true,
  imports: [CommonModule, IonicModule],
  template: `
    <div class="bg-slate-50 rounded-3xl p-8 border border-slate-100 shadow-inner">
      <div class="flex justify-between items-baseline mb-3">
        <span class="text-slate-500 font-bold text-xs uppercase tracking-widest">Total Price</span>
        <span class="text-4xl font-display font-bold text-blue-600 tracking-tight">{{ formatPrice(total) }}</span>
      </div>
      
      <div class="flex items-center text-emerald-600 text-sm font-bold mb-6">
        <ion-icon name="checkmark-circle" class="mr-2 text-xl"></ion-icon>
        No surge pricing
      </div>

      @if (showBreakdown) {
        <div class="space-y-3 pt-6 border-t border-slate-200">
          <div class="flex justify-between text-sm">
            <div class="flex flex-col">
              <span class="text-slate-900 font-bold">Fare</span>
              <span class="text-[10px] text-emerald-600 font-black uppercase tracking-widest">Fair pay for drivers</span>
            </div>
            <span class="font-bold text-slate-900">{{ formatPrice(fare) }}</span>
          </div>
          <div class="flex justify-between text-sm">
            <div class="flex flex-col">
              <span class="text-slate-500 font-medium">Service Fee</span>
              <span class="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Platform support</span>
            </div>
            <span class="font-bold text-slate-900">{{ formatPrice(serviceFee) }}</span>
          </div>
        </div>
      } @else {
        <p class="text-[10px] text-slate-400 font-bold uppercase tracking-widest text-center mt-4">
          Includes a small service fee to support the platform
        </p>
      }
      
      <p class="mt-6 text-[10px] text-slate-400 uppercase tracking-widest font-bold text-center">
        Transparent & Fair Pricing
      </p>
    </div>
  `
})
export class PriceDisplayComponent {
  private config = inject(AppConfigService);

  @Input() total = 0;
  @Input() fare = 0;
  @Input() serviceFee = 0;
  @Input() showBreakdown = true;

  formatPrice(amount: number): string {
    return this.config.formatCurrency(amount);
  }
}

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
        <span class="text-slate-500 font-bold text-xs uppercase tracking-widest">Total Reserved Today</span>
        <span class="text-4xl font-display font-bold text-blue-600 tracking-tight">{{ formatPrice(total + itemBudget) }}</span>
      </div>

      <div class="mb-6 p-3 bg-blue-50/50 rounded-2xl border border-blue-100/50 flex gap-3 items-start">
        <ion-icon name="information-circle-outline" class="text-blue-600 text-lg mt-0.5"></ion-icon>
        <p class="text-[10px] text-blue-800 font-medium leading-relaxed">
          This total is reserved from your wallet now. The <span class="font-bold">Service Estimate</span> is paid to the driver, and the <span class="font-bold">Item Budget</span> is available for them to spend on your behalf.
        </p>
      </div>

      <div class="space-y-3 mb-6">
        <div class="p-4 bg-white rounded-2xl border border-slate-100 flex justify-between items-center shadow-sm">
          <div class="flex flex-col">
            <span class="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Service Estimate</span>
            <span class="text-xs font-bold text-slate-600">Fare & Platform Fee</span>
          </div>
          <span class="text-lg font-display font-bold text-slate-900">{{ formatPrice(total) }}</span>
        </div>

        @if (itemBudget > 0) {
          <div class="p-4 bg-white rounded-2xl border border-slate-100 flex justify-between items-center shadow-sm animate-in fade-in slide-in-from-top-2">
            <div class="flex flex-col">
              <span class="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Item Budget</span>
              <span class="text-xs font-bold text-slate-600 italic">Reserved for driver spending</span>
            </div>
            <span class="text-lg font-display font-bold text-slate-900">{{ formatPrice(itemBudget) }}</span>
          </div>
          <p class="text-[10px] text-emerald-600 font-bold uppercase tracking-widest text-center px-2">
            Unused item budget will be returned to your wallet after completion.
          </p>
        }
      </div>
      
      <div class="flex items-center text-emerald-600 text-sm font-bold mb-6 justify-center">
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

      @if (minimumFareApplied) {
        <div class="mt-4 p-2 bg-blue-50 rounded-xl text-[10px] text-blue-600 font-bold uppercase tracking-widest text-center border border-blue-100">
          Minimum fare applied
        </div>
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
  @Input() itemBudget = 0;
  @Input() showBreakdown = true;
  @Input() minimumFareApplied = false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  formatPrice(amount: any): string {
    const numericAmount = typeof amount === 'string' ? parseFloat(amount) : amount;
    if (isNaN(numericAmount)) return this.config.formatCurrency(0);
    return this.config.formatCurrency(numericAmount);
  }
}

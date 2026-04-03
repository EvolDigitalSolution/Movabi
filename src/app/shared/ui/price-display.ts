import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';

@Component({
  selector: 'app-price-display',
  standalone: true,
  imports: [CommonModule, IonicModule],
  template: `
    <div class="bg-gray-50 rounded-2xl p-6 border border-gray-100">
      <div class="flex justify-between items-baseline mb-2">
        <span class="text-text-secondary font-medium">Total Price</span>
        <span class="text-3xl font-bold text-primary">£{{ total }}</span>
      </div>
      
      <div class="flex items-center text-green-600 text-sm font-semibold mb-4">
        <ion-icon name="checkmark-circle" class="mr-1.5 text-lg"></ion-icon>
        No surge pricing
      </div>

      <div *ngIf="showBreakdown" class="space-y-2 pt-4 border-t border-gray-200">
        <div class="flex justify-between text-sm">
          <span class="text-text-secondary">Driver Earnings</span>
          <span class="font-medium text-text-primary">£{{ driverEarnings }}</span>
        </div>
        <div class="flex justify-between text-sm">
          <span class="text-text-secondary">Platform Fee</span>
          <span class="font-medium text-text-primary">£{{ platformFee }}</span>
        </div>
      </div>
      
      <p class="mt-4 text-[10px] text-text-secondary uppercase tracking-widest font-bold text-center">
        Transparent & Fair Pricing
      </p>
    </div>
  `
})
export class PriceDisplayComponent {
  @Input() total: number = 0;
  @Input() driverEarnings: number = 0;
  @Input() platformFee: number = 0;
  @Input() showBreakdown = true;
}

import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, NavController } from '@ionic/angular';
import { DriverService } from '../../../../../core/services/driver/driver.service';

@Component({
  selector: 'app-earnings',
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/driver"></ion-back-button>
        </ion-buttons>
        <ion-title>My Earnings</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="ion-padding">
      <div class="bg-blue-600 rounded-3xl p-8 mb-8 text-white shadow-lg text-center relative overflow-hidden">
        <div class="relative z-10">
          <p class="text-blue-100 text-sm font-medium mb-2 uppercase tracking-widest">Total Balance</p>
          <h2 class="text-5xl font-bold">{{ '$' }}{{ totalBalance() }}</h2>
          <ion-button fill="clear" class="mt-4 text-white font-bold">
            Withdraw Funds <ion-icon name="arrow-forward" slot="end"></ion-icon>
          </ion-button>
        </div>
        <ion-icon name="wallet" class="absolute -right-4 -bottom-4 text-9xl text-white/10 rotate-12"></ion-icon>
      </div>

      <h3 class="text-lg font-bold mb-4">Recent Transactions</h3>
      
      @if (earnings().length === 0) {
        <div class="text-center mt-20">
          <ion-icon name="receipt-outline" class="text-6xl text-gray-300"></ion-icon>
          <p class="text-gray-500 mt-4">No earnings yet.</p>
        </div>
      }

      <ion-list lines="none">
        @for (earning of earnings(); track earning.id) {
          <ion-item class="mb-4 bg-white rounded-2xl shadow-sm border border-gray-100">
            <ion-icon name="cash-outline" slot="start" class="text-2xl text-green-500"></ion-icon>
            <ion-label>
              <div class="flex justify-between items-center">
                <h3 class="font-bold">Trip Payment</h3>
                <span class="font-bold text-green-600">+{{ '$' }}{{ earning.amount }}</span>
              </div>
              <p class="text-xs text-gray-400 mt-1">{{ earning.created_at | date:'medium' }}</p>
            </ion-label>
          </ion-item>
        }
      </ion-list>
    </ion-content>
  `,
  standalone: true,
  imports: [IonicModule, CommonModule]
})
export class EarningsPage implements OnInit {
  private driverService = inject(DriverService);
  public nav = inject(NavController);

  earnings = this.driverService.earnings;
  totalBalance = signal(0);

  ngOnInit() {
    this.driverService.fetchEarnings();
    this.calculateTotal();
  }

  private calculateTotal() {
    const total = this.earnings().reduce((sum: number, e: any) => sum + e.amount, 0);
    this.totalBalance.set(total);
  }
}

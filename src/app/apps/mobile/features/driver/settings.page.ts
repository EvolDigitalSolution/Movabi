import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule, NavController } from '@ionic/angular';
import { DriverService } from '../../../../core/services/driver/driver.service';

@Component({
  selector: 'app-driver-settings',
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-back-button defaultHref="/driver"></ion-back-button>
        </ion-buttons>
        <ion-title>Driver Settings</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content>
      <ion-list lines="full">
        <ion-list-header>
          <ion-label>Verification</ion-label>
        </ion-list-header>
        <ion-item button (click)="uploadDoc('license')">
          <ion-icon name="card-outline" slot="start"></ion-icon>
          <ion-label>Driver's License</ion-label>
          <ion-note slot="end">Pending</ion-note>
        </ion-item>
        <ion-item button (click)="uploadDoc('insurance')">
          <ion-icon name="shield-checkmark-outline" slot="start"></ion-icon>
          <ion-label>Vehicle Insurance</ion-label>
          <ion-note slot="end">Missing</ion-note>
        </ion-item>

        <ion-list-header class="mt-4">
          <ion-label>Vehicle</ion-label>
        </ion-list-header>
        <ion-item>
          <ion-icon name="car-outline" slot="start"></ion-icon>
          <ion-label>
            <h3>Toyota Prius</h3>
            <p>ABC-1234 • White</p>
          </ion-label>
        </ion-item>

        <ion-list-header class="mt-4">
          <ion-label>Subscription</ion-label>
        </ion-list-header>
        <ion-item button (click)="nav.navigateForward('/driver/subscription')">
          <ion-icon name="star-outline" slot="start"></ion-icon>
          <ion-label>Weekly Plan</ion-label>
          <ion-note slot="end" color="success">Active</ion-note>
        </ion-item>
      </ion-list>

      <div class="p-6">
        <ion-button expand="block" color="danger" fill="outline">Delete Account</ion-button>
      </div>
    </ion-content>
  `,
  standalone: true,
  imports: [IonicModule, CommonModule]
})
export class DriverSettingsPage {
  public nav = inject(NavController);
  private driverService = inject(DriverService);

  async uploadDoc(type: string) {
    // In a real app, this would open a file picker
    console.log('Upload doc:', type);
  }
}

import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { IonicModule, NavController, LoadingController, ToastController } from '@ionic/angular';
import { DriverService } from '../../../../../core/services/driver/driver.service';

@Component({
  selector: 'app-driver-onboarding',
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-title>Driver Onboarding</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="ion-padding">
      <div class="mb-8 text-center">
        <div class="w-24 h-24 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <ion-icon name="person-add-outline" class="text-4xl text-blue-600"></ion-icon>
        </div>
        <h1 class="text-2xl font-bold">Complete Your Profile</h1>
        <p class="text-gray-500">We need a few details to get you on the road.</p>
      </div>

      <form [formGroup]="onboardingForm" (ngSubmit)="submit()">
        <ion-list lines="none">
          <ion-list-header>
            <ion-label>Vehicle Details</ion-label>
          </ion-list-header>
          
          <ion-item class="mb-2 bg-gray-50 rounded-xl">
            <ion-label position="stacked">Make</ion-label>
            <ion-input formControlName="make" placeholder="e.g. Toyota"></ion-input>
          </ion-item>

          <ion-item class="mb-2 bg-gray-50 rounded-xl">
            <ion-label position="stacked">Model</ion-label>
            <ion-input formControlName="model" placeholder="e.g. Corolla"></ion-input>
          </ion-item>

          <ion-item class="mb-2 bg-gray-50 rounded-xl">
            <ion-label position="stacked">Year</ion-label>
            <ion-input type="number" formControlName="year" placeholder="e.g. 2022"></ion-input>
          </ion-item>

          <ion-item class="mb-2 bg-gray-50 rounded-xl">
            <ion-label position="stacked">License Plate</ion-label>
            <ion-input formControlName="license_plate" placeholder="e.g. ABC-1234"></ion-input>
          </ion-item>

          <ion-list-header class="mt-6">
            <ion-label>Documents</ion-label>
          </ion-list-header>

          <div class="grid grid-cols-2 gap-4 p-4">
            <ion-card (click)="upload('license')" button="true" class="m-0 border-2 border-dashed border-gray-200 rounded-2xl p-4 text-center active:bg-gray-50 transition-colors border-none shadow-none">
              <ion-icon name="card-outline" class="text-2xl text-gray-400 mb-2"></ion-icon>
              <p class="text-xs font-medium">Driver's License</p>
              @if (docs().license) {
                <ion-badge color="success" class="mt-2">Uploaded</ion-badge>
              }
            </ion-card>
            <ion-card (click)="upload('insurance')" button="true" class="m-0 border-2 border-dashed border-gray-200 rounded-2xl p-4 text-center active:bg-gray-50 transition-colors border-none shadow-none">
              <ion-icon name="shield-checkmark-outline" class="text-2xl text-gray-400 mb-2"></ion-icon>
              <p class="text-xs font-medium">Insurance</p>
              @if (docs().insurance) {
                <ion-badge color="success" class="mt-2">Uploaded</ion-badge>
              }
            </ion-card>
          </div>
        </ion-list>

        <ion-button expand="block" type="submit" class="mt-8" [disabled]="!onboardingForm.valid || !docs().license || !docs().insurance">
          Submit for Verification
        </ion-button>
      </form>
    </ion-content>
  `,
  standalone: true,
  imports: [IonicModule, CommonModule, FormsModule, ReactiveFormsModule]
})
export class OnboardingPage {
  private fb = inject(FormBuilder);
  private driverService = inject(DriverService);
  private loadingCtrl = inject(LoadingController);
  private toastCtrl = inject(ToastController);
  private nav = inject(NavController);

  onboardingForm: FormGroup;
  docs = signal<{ license?: string, insurance?: string }>({});

  constructor() {
    this.onboardingForm = this.fb.group({
      make: ['', Validators.required],
      model: ['', Validators.required],
      year: [new Date().getFullYear(), [Validators.required, Validators.min(1900)]],
      license_plate: ['', Validators.required]
    });
  }

  async upload(type: 'license' | 'insurance') {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,application/pdf';
    input.onchange = async (e: Event) => {
      const target = e.target as HTMLInputElement;
      const file = target.files?.[0];
      if (file) {
        const loading = await this.loadingCtrl.create({ message: 'Uploading...' });
        await loading.present();
        try {
          const path = await this.driverService.uploadDocument(file, type);
          this.docs.update(d => ({ ...d, [type]: path }));
          await loading.dismiss();
        } catch {
          await loading.dismiss();
          const toast = await this.toastCtrl.create({ message: 'Upload failed', duration: 2000, color: 'danger' });
          toast.present();
        }
      }
    };
    input.click();
  }

  async submit() {
    const loading = await this.loadingCtrl.create({ message: 'Saving details...' });
    await loading.present();

    try {
      await this.driverService.updateVehicle(this.onboardingForm.value);
      await loading.dismiss();
      const toast = await this.toastCtrl.create({ 
        message: 'Application submitted! We will verify your documents shortly.', 
        duration: 3000, 
        color: 'success' 
      });
      toast.present();
      this.nav.navigateRoot('/driver');
    } catch (err: unknown) {
      await loading.dismiss();
      const message = err instanceof Error ? err.message : 'An error occurred';
      const toast = await this.toastCtrl.create({ message, duration: 3000, color: 'danger' });
      toast.present();
    }
  }
}

import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { IonicModule, NavController, LoadingController, ToastController } from '@ionic/angular';
import { DriverService } from '../../../../../core/services/driver/driver.service';

import { CardComponent, ButtonComponent, BadgeComponent } from '../../../../../shared/ui';

@Component({
  selector: 'app-driver-onboarding',
  template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-4 pt-4 bg-white">
        <ion-title class="font-display font-bold text-xl text-slate-900">Driver Onboarding</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="bg-slate-50">
      <div class="max-w-md mx-auto p-6">
        <div class="mb-10 text-center">
          <div class="w-24 h-24 bg-blue-50 rounded-[2rem] flex items-center justify-center mx-auto mb-6 border border-blue-100 shadow-xl shadow-blue-600/10">
            <ion-icon name="person-add-outline" class="text-4xl text-blue-600"></ion-icon>
          </div>
          <h1 class="text-3xl font-display font-bold text-slate-900 mb-3">Complete Your Profile</h1>
          <p class="text-slate-500 font-medium mb-6">We need a few details to get you on the road.</p>
          
          <div class="bg-blue-50 rounded-2xl p-6 border border-blue-100 text-left">
            <div class="flex items-center gap-3 mb-2">
              <ion-icon name="options-outline" class="text-blue-600 text-xl"></ion-icon>
              <h4 class="font-bold text-slate-900">Choose your way to earn</h4>
            </div>
            <p class="text-xs text-slate-600 leading-relaxed">
              Start on our <span class="font-bold">Starter Plan</span> (£0/month) and pay only when you earn, or upgrade to <span class="font-bold">Pro</span> to keep 100% of your fares.
            </p>
          </div>
        </div>

        <form [formGroup]="onboardingForm" (ngSubmit)="submit()" class="space-y-8">
          <!-- Vehicle Details -->
          <section>
            <div class="flex items-center gap-3 mb-4 ml-1">
              <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
              <h2 class="text-xs font-bold text-slate-400 uppercase tracking-[0.2em]">Vehicle Details</h2>
            </div>
            
            <app-card class="p-0 overflow-hidden">
              <div class="divide-y divide-slate-50">
                <div class="p-4 group">
                  <label for="make" class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1 group-focus-within:text-blue-600 transition-colors">Make</label>
                  <input id="make" formControlName="make" placeholder="e.g. Toyota" class="w-full bg-transparent border-none outline-none text-sm font-bold text-slate-900 placeholder:text-slate-300">
                </div>
                <div class="p-4 group">
                  <label for="model" class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1 group-focus-within:text-blue-600 transition-colors">Model</label>
                  <input id="model" formControlName="model" placeholder="e.g. Corolla" class="w-full bg-transparent border-none outline-none text-sm font-bold text-slate-900 placeholder:text-slate-300">
                </div>
                <div class="p-4 group">
                  <label for="year" class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1 group-focus-within:text-blue-600 transition-colors">Year</label>
                  <input id="year" type="number" formControlName="year" placeholder="e.g. 2022" class="w-full bg-transparent border-none outline-none text-sm font-bold text-slate-900 placeholder:text-slate-300">
                </div>
                <div class="p-4 group">
                  <label for="license_plate" class="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1 group-focus-within:text-blue-600 transition-colors">License Plate</label>
                  <input id="license_plate" formControlName="license_plate" placeholder="e.g. ABC-1234" class="w-full bg-transparent border-none outline-none text-sm font-bold text-slate-900 placeholder:text-slate-300">
                </div>
              </div>
            </app-card>
          </section>

          <!-- Documents -->
          <section>
            <div class="flex items-center gap-3 mb-4 ml-1">
              <div class="w-1.5 h-6 bg-blue-600 rounded-full shadow-lg shadow-blue-600/20"></div>
              <h2 class="text-xs font-bold text-slate-400 uppercase tracking-[0.2em]">Documents</h2>
            </div>

            <div class="grid grid-cols-2 gap-4">
              <app-card (click)="upload('license')" class="cursor-pointer active:scale-[0.98] transition-transform text-center py-8 group hover:border-blue-200 hover:bg-blue-50/30">
                <div class="w-12 h-12 rounded-2xl bg-slate-50 flex items-center justify-center text-slate-400 mx-auto mb-3 group-hover:bg-blue-100 group-hover:text-blue-600 transition-colors">
                  <ion-icon name="card-outline" class="text-2xl"></ion-icon>
                </div>
                <p class="text-[10px] font-bold text-slate-900 uppercase tracking-widest">Driver's License</p>
                @if (docs().license) {
                  <div class="mt-3">
                    <app-badge variant="success">Uploaded</app-badge>
                  </div>
                }
              </app-card>

              <app-card (click)="upload('insurance')" class="cursor-pointer active:scale-[0.98] transition-transform text-center py-8 group hover:border-emerald-200 hover:bg-emerald-50/30">
                <div class="w-12 h-12 rounded-2xl bg-slate-50 flex items-center justify-center text-slate-400 mx-auto mb-3 group-hover:bg-emerald-100 group-hover:text-emerald-600 transition-colors">
                  <ion-icon name="shield-checkmark-outline" class="text-2xl"></ion-icon>
                </div>
                <p class="text-[10px] font-bold text-slate-900 uppercase tracking-widest">Insurance</p>
                @if (docs().insurance) {
                  <div class="mt-3">
                    <app-badge variant="success">Uploaded</app-badge>
                  </div>
                }
              </app-card>
            </div>
          </section>

          <div class="pt-6">
            <app-button 
              type="submit" 
              class="w-full" 
              [disabled]="!onboardingForm.valid || !docs().license || !docs().insurance"
            >
              Submit for Verification
            </app-button>
            <p class="text-[10px] text-slate-400 font-bold uppercase tracking-widest text-center mt-6 px-8 leading-relaxed">
              By submitting, you agree to our terms of service and driver agreement.
            </p>
          </div>
        </form>
      </div>
    </ion-content>
  `,
  standalone: true,
  imports: [IonicModule, CommonModule, FormsModule, ReactiveFormsModule, CardComponent, ButtonComponent, BadgeComponent]
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

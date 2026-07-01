import { CommonModule } from '@angular/common';
import { Component, inject, OnInit, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import {
    AlertController,
    IonBackButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonTitle,
    IonToolbar,
    LoadingController,
    ToastController
} from '@ionic/angular/standalone';
import { Router } from '@angular/router';
import { addIcons } from 'ionicons';
import {
    callOutline,
    chevronBackOutline,
    closeCircleOutline,
    globeOutline,
    mailOutline,
    personCircleOutline,
    saveOutline,
    trashOutline
} from 'ionicons/icons';

import { AuthService } from '@core/services/auth/auth.service';
import { ProfileService } from '@core/services/profile/profile.service';
import { StorageUploadService } from '@core/services/storage/storage-upload.service';
import { ButtonComponent } from '@shared/ui';
import { Profile } from '@shared/models/booking.model';

@Component({
    selector: 'app-account-settings',
    standalone: true,
    imports: [
        CommonModule,
        ReactiveFormsModule,
        IonHeader,
        IonToolbar,
        IonButtons,
        IonBackButton,
        IonTitle,
        IonContent,
        IonIcon,
        ButtonComponent
    ],
    template: `
    <ion-header class="ion-no-border">
      <ion-toolbar class="px-3 pt-4 bg-slate-50">
        <ion-buttons slot="start">
          <ion-back-button [defaultHref]="defaultBackHref()" text="" icon="chevron-back-outline"></ion-back-button>
        </ion-buttons>

        <ion-title class="font-display font-black text-slate-950 tracking-tight">
          Account Settings
        </ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content class="bg-slate-50">
      <div class="w-full max-w-xl mx-auto px-3 py-4 space-y-6 pb-24">
        <section class="rounded-[2rem] bg-white border border-slate-200 shadow-xl shadow-slate-900/10 p-5">
          <div class="flex items-start gap-4">
            <button
              type="button"
              (click)="uploadProfilePhoto()"
              class="w-16 h-16 rounded-2xl bg-amber-50 border border-amber-100 text-amber-600 flex items-center justify-center shrink-0 overflow-hidden active:scale-95 transition-all"
            >
              @if (photoUrl()) {
                <img [src]="photoUrl()" alt="Profile photo" class="w-full h-full object-cover" />
              } @else {
                <ion-icon name="person-circle-outline" class="text-4xl"></ion-icon>
              }
            </button>

            <div class="min-w-0">
              <p class="text-[10px] font-black uppercase tracking-[0.2em] text-amber-600 mb-2">
                Movabi profile
              </p>
              <h1 class="font-display font-black text-2xl text-slate-950 tracking-tight">
                Keep your details up to date
              </h1>
              <p class="text-sm text-slate-600 font-semibold leading-relaxed mt-2">
                Your name and phone help customers and drivers recognise each other safely.
              </p>
              <button
                type="button"
                (click)="uploadProfilePhoto()"
                class="mt-3 text-[10px] font-black uppercase tracking-widest text-amber-600"
              >
                {{ photoUrl() ? 'Change photo' : 'Upload photo' }}
              </button>
            </div>
          </div>
        </section>

        <form [formGroup]="form" (ngSubmit)="save()" class="rounded-[2rem] bg-white border border-slate-200 shadow-sm overflow-hidden">
          <div class="divide-y divide-slate-100">
            <label class="flex items-center gap-4 p-4">
              <span class="w-11 h-11 rounded-2xl bg-slate-50 border border-slate-100 text-slate-500 flex items-center justify-center shrink-0">
                <ion-icon name="person-circle-outline" class="text-xl"></ion-icon>
              </span>
              <span class="min-w-0 flex-1">
                <span class="block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Full name</span>
                <input formControlName="full_name" placeholder="Your name" class="w-full bg-transparent border-none outline-none text-base font-bold text-slate-950 placeholder:text-slate-300">
              </span>
            </label>

            <label class="flex items-center gap-4 p-4">
              <span class="w-11 h-11 rounded-2xl bg-slate-50 border border-slate-100 text-slate-500 flex items-center justify-center shrink-0">
                <ion-icon name="call-outline" class="text-xl"></ion-icon>
              </span>
              <span class="min-w-0 flex-1">
                <span class="block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Phone</span>
                <input type="tel" formControlName="phone" placeholder="Mobile number" class="w-full bg-transparent border-none outline-none text-base font-bold text-slate-950 placeholder:text-slate-300">
              </span>
            </label>

            <label class="flex items-center gap-4 p-4">
              <span class="w-11 h-11 rounded-2xl bg-slate-50 border border-slate-100 text-slate-500 flex items-center justify-center shrink-0">
                <ion-icon name="globe-outline" class="text-xl"></ion-icon>
              </span>
              <span class="min-w-0 flex-1">
                <span class="block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Country code</span>
                <input formControlName="country_code" placeholder="GB" maxlength="2" class="w-full bg-transparent border-none outline-none text-base font-bold text-slate-950 placeholder:text-slate-300 uppercase">
              </span>
            </label>

            <div class="flex items-center gap-4 p-4 bg-slate-50">
              <span class="w-11 h-11 rounded-2xl bg-white border border-slate-100 text-slate-500 flex items-center justify-center shrink-0">
                <ion-icon name="mail-outline" class="text-xl"></ion-icon>
              </span>
              <span class="min-w-0 flex-1">
                <span class="block text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Email</span>
                <span class="block text-base font-bold text-slate-600 truncate">{{ email() }}</span>
              </span>
            </div>
          </div>

          <div class="p-4">
            <app-button type="submit" class="w-full" [disabled]="saving() || form.invalid">
              <span class="inline-flex items-center justify-center gap-2">
                <ion-icon name="save-outline"></ion-icon>
                Save Changes
              </span>
            </app-button>
          </div>
        </form>

        <section class="rounded-[2rem] bg-white border border-rose-100 shadow-sm p-5">
          <div class="flex items-start gap-4">
            <div class="w-12 h-12 rounded-2xl bg-rose-50 border border-rose-100 text-rose-600 flex items-center justify-center shrink-0">
              <ion-icon name="close-circle-outline" class="text-2xl"></ion-icon>
            </div>

            <div class="min-w-0 flex-1">
              <h2 class="font-display font-black text-slate-950 text-lg">Close account</h2>
              <p class="text-sm text-slate-600 font-semibold leading-relaxed mt-2">
                Closing your account disables access. Movabi may keep booking, payment, safety, tax, and legal records where required.
              </p>
            </div>
          </div>

          <div class="mt-5">
            <app-button variant="error" class="w-full" [disabled]="saving()" (clicked)="confirmCloseAccount()">
              <span class="inline-flex items-center justify-center gap-2">
                <ion-icon name="trash-outline"></ion-icon>
                Request Account Closure
              </span>
            </app-button>
          </div>
        </section>
      </div>
    </ion-content>
  `
})
export class AccountSettingsPage implements OnInit {
    private fb = inject(FormBuilder);
    private auth = inject(AuthService);
    private profileService = inject(ProfileService);
    private storageUpload = inject(StorageUploadService);
    private loadingCtrl = inject(LoadingController);
    private toastCtrl = inject(ToastController);
    private alertCtrl = inject(AlertController);
    private router = inject(Router);

    saving = signal(false);
    email = signal('');
    photoUrl = signal<string | null>(null);

    form = this.fb.group({
        full_name: ['', [Validators.required, Validators.minLength(2)]],
        phone: ['', [Validators.minLength(8)]],
        country_code: ['GB', [Validators.required, Validators.minLength(2), Validators.maxLength(2)]]
    });

    constructor() {
        addIcons({
            callOutline,
            chevronBackOutline,
            closeCircleOutline,
            globeOutline,
            mailOutline,
            personCircleOutline,
            saveOutline,
            trashOutline
        });
    }

    async ngOnInit() {
        const user = this.auth.currentUser();
        this.email.set(user?.email || '');

        let profile = this.profileService.profile();

        if (!profile && user?.id) {
            profile = await this.profileService.fetchProfile(user.id);
        }

        if (profile) {
            this.patchProfile(profile);
        }
    }

    defaultBackHref(): string {
        return this.auth.userRole() === 'driver' ? '/driver' : '/customer';
    }

    private patchProfile(profile: Profile) {
        this.form.patchValue(
            {
                full_name: profile.full_name || [profile.first_name, profile.last_name].filter(Boolean).join(' ') || '',
                phone: profile.phone || '',
                country_code: profile.country_code || 'GB'
            },
            { emitEvent: false }
        );
        this.photoUrl.set(profile.avatar_url || null);
    }

    async uploadProfilePhoto() {
        if (this.saving()) return;

        const user = this.auth.currentUser();

        if (!user?.id) {
            await this.showToast('Please sign in again to upload your photo.', 'danger');
            return;
        }

        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/jpeg,image/png,image/webp';

        input.onchange = async (event: Event) => {
            const target = event.target as HTMLInputElement;
            const file = target.files?.[0];

            if (!file) return;

            if (!this.isAllowedImage(file)) {
                await this.showToast('Please upload a JPG, PNG, or WEBP photo under 8MB.', 'warning');
                return;
            }

            this.saving.set(true);
            const loading = await this.loadingCtrl.create({ message: 'Uploading photo...' });
            await loading.present();

            try {
                const path = await this.storageUpload.uploadProfileImage(user.id, file);
                const publicUrl = await this.storageUpload.getPublicUrl('profiles', path);
                await this.profileService.updateProfile(user.id, { avatar_url: publicUrl } as Partial<Profile>);
                this.photoUrl.set(publicUrl);
                await this.showToast('Profile photo updated.', 'success');
            } catch {
                await this.showToast('Photo upload failed.', 'danger');
            } finally {
                this.saving.set(false);
                target.value = '';
                await loading.dismiss();
            }
        };

        input.click();
    }

    async save() {
        this.form.markAllAsTouched();
        if (this.form.invalid || this.saving()) return;

        const user = this.auth.currentUser();

        if (!user?.id) {
            await this.showToast('Please sign in again to save changes.', 'danger');
            return;
        }

        this.saving.set(true);
        const loading = await this.loadingCtrl.create({ message: 'Saving account details...' });
        await loading.present();

        try {
            const raw = this.form.getRawValue();
            const fullName = String(raw.full_name || '').trim();

            await this.profileService.updateProfile(user.id, {
                full_name: fullName,
                phone: String(raw.phone || '').trim(),
                country_code: String(raw.country_code || 'GB').trim().toUpperCase()
            } as Partial<Profile>);

            await this.showToast('Account details updated.', 'success');
        } catch {
            await this.showToast('Could not save account details.', 'danger');
        } finally {
            this.saving.set(false);
            await loading.dismiss();
        }
    }

    async confirmCloseAccount() {
        const alert = await this.alertCtrl.create({
            header: 'Request account closure?',
            message: 'This will disable your Movabi access. Your records may be retained for booking, payment, safety, tax and legal purposes.',
            inputs: [
                {
                    name: 'understood',
                    type: 'checkbox',
                    label: 'I understand my account access will be disabled.',
                    value: 'yes'
                },
                {
                    name: 'reason',
                    type: 'textarea',
                    placeholder: 'Optional reason'
                }
            ],
            buttons: [
                { text: 'Cancel', role: 'cancel' },
                {
                    text: 'Request Closure',
                    role: 'destructive',
                    handler: (value) => {
                        const understood = Array.isArray(value) ? value.includes('yes') : Boolean(value?.understood);
                        const reason = Array.isArray(value) ? '' : String(value?.reason || '').trim();

                        if (!understood) {
                            void this.showToast('Please confirm you understand before continuing.', 'warning');
                            return false;
                        }

                        void this.closeAccount(reason);
                        return true;
                    }
                }
            ]
        });

        await alert.present();
    }

    private async closeAccount(reason = '') {
        const user = this.auth.currentUser();

        if (!user?.id) {
            await this.showToast('Please sign in again to close your account.', 'danger');
            return;
        }

        this.saving.set(true);
        const loading = await this.loadingCtrl.create({ message: 'Requesting account closure...' });
        await loading.present();

        try {
            const now = new Date().toISOString();
            await this.profileService.updateProfile(user.id, {
                account_status: 'closure_requested',
                closure_requested_at: now,
                account_closure_requested_at: now,
                closure_reason: reason || null,
                account_closure_reason: reason || null
            } as Partial<Profile>);
            await this.showToast('Your closure request has been received. You can contact support if this was a mistake.', 'success');
            await this.router.navigate(['/auth/blocked'], { replaceUrl: true });
        } catch {
            await this.showToast('Could not request account closure.', 'danger');
        } finally {
            this.saving.set(false);
            await loading.dismiss();
        }
    }

    private isAllowedImage(file: File): boolean {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
        return allowedTypes.includes(file.type) && file.size <= 8 * 1024 * 1024;
    }

    private async showToast(message: string, color: 'success' | 'danger' | 'warning') {
        const toast = await this.toastCtrl.create({
            message,
            color,
            duration: 2400,
            position: 'top'
        });

        await toast.present();
    }
}

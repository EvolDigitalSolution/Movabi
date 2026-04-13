import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { AuthService } from '@core/services/auth/auth.service';
import { ButtonComponent } from '@shared/ui';

@Component({
  selector: 'app-blocked',
  template: `
    <ion-content class="ion-padding">
      <div class="flex flex-col items-center justify-center h-full text-center space-y-8 max-w-md mx-auto">
        <div class="w-24 h-24 bg-red-50 rounded-full flex items-center justify-center text-red-600">
          <ion-icon name="alert-circle" class="text-6xl"></ion-icon>
        </div>
        
        <div class="space-y-3">
          <h1 class="text-3xl font-display font-bold text-slate-900">Account Restricted</h1>
          <p class="text-slate-500 leading-relaxed">
            Your account has been <strong>{{ auth.accountStatus() }}</strong>. 
            This may be due to a violation of our terms of service or pending verification.
          </p>
        </div>

        @if (auth.profileService.profile()?.moderation_reason) {
          <div class="w-full p-6 bg-slate-50 rounded-3xl border border-slate-100 text-left">
            <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Reason provided:</p>
            <p class="text-sm text-slate-700 italic">"{{ auth.profileService.profile()?.moderation_reason }}"</p>
          </div>
        }

        <div class="space-y-4 w-full">
          <p class="text-sm text-slate-400">If you believe this is a mistake, please contact support.</p>
          <app-button variant="outline" class="w-full" (clicked)="auth.signOut()">Sign Out</app-button>
        </div>
      </div>
    </ion-content>
  `,
  standalone: true,
  imports: [CommonModule, IonicModule, ButtonComponent]
})
export class BlockedPage {
  public auth = inject(AuthService);
}

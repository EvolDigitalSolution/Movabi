import { Component, inject, OnInit } from '@angular/core';
import { IonicModule } from '@ionic/angular';
import { Router } from '@angular/router';
import { AuthService } from '../../../../core/services/auth/auth.service';
import { CommonModule } from '@angular/common';
import { toObservable } from '@angular/core/rxjs-interop';
import { filter, firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-auth-callback',
  template: `
    <ion-content class="ion-padding bg-slate-50">
      <div class="flex flex-col items-center justify-center h-full text-center space-y-8">
        <div class="w-20 h-20 bg-white rounded-[2rem] flex items-center justify-center shadow-2xl shadow-slate-200/50 border border-slate-100">
          <ion-spinner name="crescent" color="primary"></ion-spinner>
        </div>
        <div class="space-y-2">
          <h3 class="text-xl font-display font-bold text-slate-900">Authenticating...</h3>
          <p class="text-slate-500 font-medium">Please wait while we finalize your session.</p>
        </div>
      </div>
    </ion-content>
  `,
  standalone: true,
  imports: [IonicModule, CommonModule]
})
export class AuthCallbackPage implements OnInit {
  private auth = inject(AuthService);
  private router = inject(Router);

  async ngOnInit() {
    // Wait for auth to be ready
    if (!this.auth.isAuthReady()) {
      await firstValueFrom(
        toObservable(this.auth.isAuthReady).pipe(filter(ready => ready))
      );
    }

    await this.auth.handlePostAuthRedirect();
  }
}

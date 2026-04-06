import { Component, inject, OnInit } from '@angular/core';
import { IonicModule } from '@ionic/angular';
import { Router } from '@angular/router';
import { AuthService } from '../../../../core/services/auth/auth.service';
import { CommonModule } from '@angular/common';

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

  ngOnInit() {
    // The AuthService constructor already listens to onAuthStateChange
    // We just need to wait for it to be ready and then redirect
    this.checkAuth();
  }

  private async checkAuth() {
    // Give it a moment to process the hash/code in the URL
    setTimeout(() => {
      const user = this.auth.currentUser();
      const role = this.auth.userRole();

      if (user && role) {
        this.redirectByRole(role);
      } else if (user) {
        // User is logged in but role is not yet loaded
        // This might happen if the profile sync is still in progress
        this.router.navigate(['/customer']);
      } else {
        // Not logged in, maybe something went wrong
        this.router.navigate(['/auth/login']);
      }
    }, 1500);
  }

  private redirectByRole(role: string) {
    if (role === 'admin') {
      this.router.navigate(['/admin']);
    } else if (role === 'driver') {
      this.router.navigate(['/driver']);
    } else {
      this.router.navigate(['/customer']);
    }
  }
}

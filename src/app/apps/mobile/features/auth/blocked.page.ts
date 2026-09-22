import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { Router } from '@angular/router';
import { AuthService } from '@core/services/auth/auth.service';
import { ProfileService } from '@core/services/profile/profile.service';
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
          <h1 class="text-3xl font-display font-bold text-slate-900">{{ title() }}</h1>
          <p class="text-slate-500 leading-relaxed">{{ body() }}</p>
        </div>

        @if (auth.profileService.profile()?.closure_reason || auth.profileService.profile()?.account_closure_reason || auth.profileService.profile()?.moderation_reason) {
          <div class="w-full p-6 bg-slate-50 rounded-3xl border border-slate-100 text-left">
            <p class="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2">Reason provided:</p>
            <p class="text-sm text-slate-700 italic">"{{ reason() }}"</p>
          </div>
        }

        <div class="space-y-4 w-full">
          <p class="text-sm text-slate-400">If you believe this is a mistake, please contact support.</p>
          <a class="block w-full rounded-2xl border border-slate-200 bg-white px-5 py-3 font-bold text-slate-700" href="mailto:support@movabi.com">
            Contact Support
          </a>
          @if (status() === 'closure_requested') {
            <app-button class="w-full" (clicked)="cancelClosureRequest()">Cancel Closure Request</app-button>
          }
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
  private profileService = inject(ProfileService);
  private router = inject(Router);

  status(): string {
    return this.auth.profileService.profile()?.account_status || this.auth.accountStatus() || 'active';
  }

  title(): string {
    if (this.status() === 'closure_requested') return 'Account closure requested';
    if (this.status() === 'closed') return 'Your account is closed';
    return 'Account Restricted';
  }

  body(): string {
    if (this.status() === 'closure_requested') {
      return 'Your closure request has been received. You can contact support if this was a mistake, or cancel the request below.';
    }

    if (this.status() === 'closed') {
      return 'Your account is closed. Contact support to reinstate your Movabi access.';
    }

    return `Your account has been ${this.status()}. This may be due to a violation of our terms of service or pending verification.`;
  }

  reason(): string {
    const profile = this.auth.profileService.profile();
    return profile?.closure_reason || profile?.account_closure_reason || profile?.moderation_reason || '';
  }

  // Batch 2C Phase B.1 — MODERATION BOUNDARY.
  //
  // This method previously wrote `account_status: 'active'` unconditionally, so a
  // SUSPENDED or BLOCKED account could be restored by the account holder from the
  // client: an immediate privilege escalation. Only a closure the user asked for
  // may be cancelled here; every other state (suspended, blocked, paused) is a
  // moderation decision and is left exactly as the platform set it. The template
  // already hides the button for those states — this guard makes the METHOD safe
  // independently of the template.
  //
  // APPLICATION-LAYER GUARD ONLY: `profiles` still has no RLS and no column-level
  // UPDATE revoke, so a hand-crafted request can still write this column. A
  // trusted server endpoint for closure cancellation, plus the Phase C column
  // revoke, is a MANDATORY Phase C prerequisite.
  async cancelClosureRequest() {
    if (this.status() !== 'closure_requested') {
      console.warn('[BlockedPage] Refused to reactivate an account that is not pending a user-requested closure.', { status: this.status() });
      return;
    }
    const user = this.auth.currentUser();
    if (!user?.id) return;

    const profile = this.auth.profileService.profile();
    const previousNotes = profile?.closure_notes ? `${profile.closure_notes}\n` : '';

    await this.profileService.updateProfile(user.id, {
      account_status: 'active',
      closure_notes: `${previousNotes}${new Date().toISOString()} - User cancelled closure request`
    } as any);

    this.auth.accountStatus.set('active');
    await this.router.navigate([this.auth.userRole() === 'driver' ? '/driver' : '/customer'], { replaceUrl: true });
  }
}

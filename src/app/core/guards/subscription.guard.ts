import { Injectable, inject } from '@angular/core';
import { CanActivate, Router, UrlTree } from '@angular/router';
import { Observable, from, map } from 'rxjs';
import { SubscriptionService } from '../services/subscription/subscription.service';
import { ProfileService } from '../services/profile/profile.service';

@Injectable({
  providedIn: 'root'
})
export class SubscriptionGuard implements CanActivate {
  private subscription = inject(SubscriptionService);
  private profileService = inject(ProfileService);
  private router = inject(Router);

  canActivate(): Observable<boolean | UrlTree> {
    const role = this.profileService.profile()?.role;

    // Only apply to drivers
    if (role !== 'driver') return from([true]);

    return from(this.subscription.checkSubscription()).pipe(
      map(sub => {
        if (sub && sub.status === 'active') {
          return true;
        }
        // Redirect to subscription page if not active
        return this.router.createUrlTree(['/driver/subscription']);
      })
    );
  }
}

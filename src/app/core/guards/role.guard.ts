import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { ProfileService } from '../services/profile/profile.service';
import { AuthService } from '../services/auth/auth.service';
import { toObservable } from '@angular/core/rxjs-interop';
import { filter, firstValueFrom } from 'rxjs';

export const roleGuard: CanActivateFn = async (route) => {
  const profileService = inject(ProfileService);
  const authService = inject(AuthService);
  const router = inject(Router);
  const expectedRole = route.data['role'] as string;

  // Wait for auth to be ready
  if (!authService.isAuthReady()) {
    await firstValueFrom(
      toObservable(authService.isAuthReady).pipe(filter(ready => ready))
    );
  }

  // If no user, authGuard will handle it, but we should be safe
  if (!authService.currentUser()) {
    return false;
  }

  // Wait for profile to be loaded (with timeout or fallback)
  if (!profileService.profile()) {
    try {
      // Try fetching it one more time if it's missing
      const user = authService.currentUser();
      if (user) {
        await profileService.fetchProfile(user.id);
      }
    } catch (e) {
      console.error('RoleGuard: Error fetching profile', e);
    }
  }

  const userProfile = profileService.profile();
  const userRole = userProfile?.role || authService.userRole();
  const onboardingCompleted = userProfile?.onboarding_completed ?? authService.onboardingCompleted();

  // 1. Check Account Status
  const status = userProfile?.account_status || authService.accountStatus();
  if (status && status !== 'active') {
    router.navigate(['/auth/blocked']);
    return false;
  }

  // 2. Onboarding Gate
  const isAtOnboardingPage = route.routeConfig?.path === 'onboarding' || route.parent?.routeConfig?.path === 'onboarding';
  
  if (userRole && !onboardingCompleted && !isAtOnboardingPage) {
    if (userRole === 'customer') {
      router.navigate(['/customer/onboarding']);
      return false;
    }
    if (userRole === 'driver') {
      router.navigate(['/driver/onboarding']);
      return false;
    }
  }

  if (userRole === expectedRole) {
    return true;
  }

  if (!userRole) {
    router.navigate(['/auth/role-selection']);
    return false;
  }

  // If user is admin but trying to access customer/driver routes
  if (userRole === 'admin') {
    router.navigate(['/admin']);
    return false;
  }

  if (userRole === 'driver' && expectedRole === 'customer') {
    router.navigate(['/driver']);
    return false;
  }

  if (userRole === 'customer' && expectedRole === 'driver') {
    router.navigate(['/customer']);
    return false;
  }

  if (expectedRole === 'admin' && (userRole === 'customer' || userRole === 'driver')) {
    router.navigate(['/auth/login']);
    return false;
  }
  
  return false;
};

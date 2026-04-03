import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { ProfileService } from '../services/profile/profile.service';

export const roleGuard: CanActivateFn = (route) => {
  const profileService = inject(ProfileService);
  const router = inject(Router);
  const expectedRole = route.data['role'] as string;

  const userRole = profileService.profile()?.role;

  if (userRole === expectedRole) {
    return true;
  }

  if (userRole === 'driver' && expectedRole === 'customer') {
    router.navigate(['/driver']);
    return false;
  }

  if (userRole === 'customer' && expectedRole === 'driver') {
    router.navigate(['/customer']);
    return false;
  }

  if (userRole === 'admin' && (expectedRole === 'customer' || expectedRole === 'driver')) {
    router.navigate(['/auth/login']);
    return false;
  }

  if (expectedRole === 'admin' && (userRole === 'customer' || userRole === 'driver')) {
    router.navigate(['/auth/login']);
    return false;
  }
  
  return false;
};

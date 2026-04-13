import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth/auth.service';
import { toObservable } from '@angular/core/rxjs-interop';
import { filter, firstValueFrom } from 'rxjs';

export const authGuard: CanActivateFn = async () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  // Wait for auth to be ready
  if (!authService.isAuthReady()) {
    await firstValueFrom(
      toObservable(authService.isAuthReady).pipe(filter(ready => ready))
    );
  }

  if (authService.currentUser()) {
    return true;
  }

  router.navigate(['/auth/login']);
  return false;
};

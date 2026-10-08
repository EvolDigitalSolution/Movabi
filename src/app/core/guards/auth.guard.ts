import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth/auth.service';
import { toObservable } from '@angular/core/rxjs-interop';
import { filter, firstValueFrom } from 'rxjs';

export const authGuard: CanActivateFn = async (_route, state) => {
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

  if (/^\/account\/messages(?:\?messageId=[0-9a-f-]{36})?$/i.test(state.url)) {
    try { sessionStorage.setItem('movabi.pendingAdminMessage', state.url); } catch { /* storage unavailable */ }
  }
  router.navigate(['/auth/login']);
  return false;
};

import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { toObservable } from '@angular/core/rxjs-interop';
import { filter, firstValueFrom } from 'rxjs';
import { AuthService } from '../services/auth/auth.service';
import { RegistrationService } from '../services/auth/registration.service';

/**
 * A valid session is NOT a fully activated Movabi account.
 *
 * A Supabase identity can exist before Movabi has validated registration-market
 * eligibility (Google sign-in, or a direct signup). Such an identity must
 * confirm its registration market before entering normal role/app progression.
 *
 * An already ACTIVATED account always passes and is never re-gated: this guard
 * never looks at GPS, IP address, browser locale, device location or travel
 * location.
 */
export const registrationGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const registration = inject(RegistrationService);
  const router = inject(Router);

  if (!auth.isAuthReady()) {
    await firstValueFrom(toObservable(auth.isAuthReady).pipe(filter(ready => ready)));
  }

  // Unauthenticated visitors are handled by authGuard.
  if (!auth.currentUser()) return true;

  const state = await registration.ensureLoaded();

  // Fail CLOSED: only a positively confirmed ACTIVATED state may enter a
  // protected route. A pending identity, and any identity whose status could
  // not be read (offline / API error), is sent to the recoverable registration
  // screen — never admitted to normal role/onboarding/app progression.
  if (state?.activated) return true;

  router.navigate(['/auth/registration'], { replaceUrl: true });
  return false;
};

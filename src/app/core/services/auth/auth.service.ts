import { Injectable, signal, inject } from '@angular/core';
import { SupabaseService } from '../supabase/supabase.service';
import { User, Session, AuthChangeEvent } from '@supabase/supabase-js';
import { Router } from '@angular/router';
import { ProfileService } from '../profile/profile.service';
import { AccountStatus } from '@shared/models/booking.model';

import { environment } from '@env/environment';

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private supabase = inject(SupabaseService);
  private router = inject(Router);

  currentUser = signal<User | null>(null);
  session = signal<Session | null>(null);
  isAuthReady = signal(false);
  userRole = signal<string | null>(null);
  onboardingCompleted = signal<boolean>(false);
  tenantId = signal<string | null>(null);
  accountStatus = signal<AccountStatus>('active');
  stripeConnectStatus = signal<'not_started' | 'pending' | 'restricted' | 'enabled'>('not_started');
  private redirecting = false;

  public profileService = inject(ProfileService);

  constructor() {
    this.init();
  }

  private async init() {
    if (!this.supabase.isConfigured) {
      console.warn('AuthService: Supabase is not configured. Auth features will be disabled.');
      this.isAuthReady.set(true);
      return;
    }

    try {
      const { data: { session } } = await this.supabase.auth.getSession();
      this.handleAuthStateChange('INITIAL_SESSION', session);
      
      this.supabase.auth.onAuthStateChange((event, session) => {
        this.handleAuthStateChange(event, session);
      });
    } catch (error) {
      console.error('AuthService Initialization Error:', error);
      this.isAuthReady.set(true);
    }
  }

  private async handleAuthStateChange(event: AuthChangeEvent | 'INITIAL_SESSION', session: Session | null) {
    this.session.set(session);
    const user = session?.user ?? null;
    this.currentUser.set(user);
    
    if (user) {
      // Fetch profile to get role and tenant_id from DB
      const profile = await this.profileService.fetchProfile(user.id);
      if (profile) {
        this.userRole.set(profile.role);
        this.onboardingCompleted.set(profile.onboarding_completed);
        this.tenantId.set(profile.tenant_id);
        this.accountStatus.set(profile.account_status || 'active');
        this.stripeConnectStatus.set(profile.stripe_connect_status || 'not_started');
      } else {
        // Fallback to metadata if profile not found yet (e.g. just signed up)
        this.userRole.set(user.user_metadata?.['role'] || null);
        this.onboardingCompleted.set(user.user_metadata?.['onboarding_completed'] || false);
        this.tenantId.set(user.user_metadata?.['tenant_id'] || null);
        this.accountStatus.set('active');
      }
    } else {
      this.userRole.set(null);
      this.onboardingCompleted.set(false);
      this.tenantId.set(null);
      this.profileService.profile.set(null);
    }

    this.isAuthReady.set(true);

    if (event === 'PASSWORD_RECOVERY') {
      this.router.navigate(['/auth/reset-password']);
    }
  }

  /**
   * Resolves the redirect URL at runtime based on the current platform/origin.
   * This ensures that auth callbacks and password resets work correctly on web (local/prod) and mobile (Capacitor).
   */
  private getRedirectUrl(path: string): string {
    // Priority: 
    // 1. Environment specific URL if defined (useful for forcing specific targets in dev)
    if (path === '/auth/callback' && environment.authCallbackUrl) {
      return environment.authCallbackUrl;
    }
    if (path === '/auth/reset-password' && environment.resetPasswordUrl) {
      return environment.resetPasswordUrl;
    }

    try {
      const origin = window.location.origin || environment.appUrl || 'http://localhost:3000';
      const cleanOrigin = origin.endsWith('/') ? origin.slice(0, -1) : origin;
      const cleanPath = path.startsWith('/') ? path : `/${path}`;
      
      // Validate the URL construction
      const finalUrl = `${cleanOrigin}${cleanPath}`;
      try {
        new URL(finalUrl);
        return finalUrl;
      } catch (e) {
        console.error('Invalid URL constructed:', finalUrl, e);
        // Fallback to a safe default if construction fails
        return `${environment.appUrl || 'http://localhost:3000'}${cleanPath}`;
      }
    } catch (e) {
      console.error('Error getting redirect URL:', e);
      return `${environment.appUrl || 'http://localhost:3000'}${path}`;
    }
  }

  async signUp(email: string, password: string, data?: Record<string, unknown>) {
    const { data: result, error } = await this.supabase.auth.signUp({
      email,
      password,
      options: {
        data,
        emailRedirectTo: this.getRedirectUrl('/auth/callback')
      }
    });
    if (error) {
      console.error('AuthService: signUp error', error);
      throw error;
    }
    localStorage.setItem('movabi_returning_user', 'true');
    return result;
  }

  async signIn(email: string, password: string) {
    const { data: result, error } = await this.supabase.auth.signInWithPassword({
      email,
      password
    });
    if (error) {
      console.error('AuthService: signIn error', error);
      throw error;
    }
    localStorage.setItem('movabi_returning_user', 'true');
    return result;
  }

  async signInWithGoogle() {
    const { error } = await this.supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: this.getRedirectUrl('/auth/callback'),
        queryParams: {
          access_type: 'offline',
          prompt: 'consent',
        },
      }
    });
    if (error) {
      console.error('AuthService: signInWithGoogle error', error);
      throw error;
    }
  }

  async signOut() {
    try {
      const { error } = await this.supabase.auth.signOut();
      if (error) throw error;
    } catch (error) {
      console.error('AuthService: signOut error', error);
    } finally {
      this.router.navigate(['/auth/login']);
    }
  }

  async resetPassword(email: string) {
    const { error } = await this.supabase.auth.resetPasswordForEmail(email, {
      redirectTo: this.getRedirectUrl('/auth/reset-password')
    });
    if (error) {
      console.error('AuthService: resetPassword error', error);
      throw error;
    }
  }

  /**
   * Centralized method to handle post-authentication redirection.
   * This ensures deterministic routing and prevents infinite loops.
   */
  async handlePostAuthRedirect(): Promise<void> {
    if (this.redirecting) return;
    this.redirecting = true;

    try {
      // 1. Wait for auth to be ready if it isn't
      if (!this.isAuthReady()) {
        const { data: { session } } = await this.supabase.auth.getSession();
        await this.handleAuthStateChange('INITIAL_SESSION', session);
      }

      const user = this.currentUser();
      if (!user) {
        await this.router.navigate(['/auth/login'], { replaceUrl: true });
        return;
      }

      // 2. Ensure profile is loaded
      let profile = this.profileService.profile();
      if (!profile || profile.id !== user.id) {
        profile = await this.profileService.fetchProfile(user.id);
      }

      // 3. Check Account Status (Moderation)
      const status = profile?.account_status || this.accountStatus() || 'active';
      if (status !== 'active') {
        await this.router.navigate(['/auth/blocked'], { replaceUrl: true });
        return;
      }

      const role = profile?.role || this.userRole();
      const onboardingCompleted = profile?.onboarding_completed ?? this.onboardingCompleted();

      // 4. Role Selection Gate
      if (!role) {
        await this.router.navigate(['/auth/role-selection'], { replaceUrl: true });
        return;
      }

      // 5. Onboarding Gate
      if (!onboardingCompleted) {
        if (role === 'driver') {
          await this.router.navigate(['/driver/onboarding'], { replaceUrl: true });
        } else if (role === 'customer') {
          await this.router.navigate(['/customer/onboarding'], { replaceUrl: true });
        } else if (role === 'admin') {
            //await this.router.navigate(['/admin'], { replaceUrl: true });
            await this.router.navigateByUrl('/dashboard', { replaceUrl: true });
        } else {
          // Fallback if role is unknown
          await this.router.navigate(['/auth/role-selection'], { replaceUrl: true });
        }
        return;
      }

      // 6. Route by Role (Onboarding Complete)
      if (role === 'admin') {
          await this.router.navigate(['/dashboard'], { replaceUrl: true });
      } else if (role === 'driver') {
        await this.router.navigate(['/driver'], { replaceUrl: true });
      } else {
        await this.router.navigate(['/customer'], { replaceUrl: true });
      }
    } catch (error) {
      console.error('Error during post-auth redirect:', error);
      await this.router.navigate(['/auth/login'], { replaceUrl: true });
    } finally {
      this.redirecting = false;
    }
  }
}

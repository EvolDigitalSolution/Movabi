import { Injectable, signal, inject } from '@angular/core';
import { SupabaseService } from '../supabase/supabase.service';
import { User, Session, AuthChangeEvent } from '@supabase/supabase-js';
import { Router } from '@angular/router';
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
  tenantId = signal<string | null>(null);

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

  private handleAuthStateChange(event: AuthChangeEvent | 'INITIAL_SESSION', session: Session | null) {
    this.session.set(session);
    this.currentUser.set(session?.user ?? null);
    this.userRole.set(session?.user?.user_metadata?.['role'] ?? null);
    this.tenantId.set(session?.user?.user_metadata?.['tenant_id'] ?? null);
    this.isAuthReady.set(true);
  }

  async signUp(email: string, password: string, data?: Record<string, unknown>) {
    const { data: result, error } = await this.supabase.auth.signUp({
      email,
      password,
      options: {
        data,
        emailRedirectTo: environment.authCallbackUrl || `${environment.appUrl}/auth/callback`
      }
    });
    if (error) {
      console.error('AuthService: signUp error', error);
      throw error;
    }
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
    return result;
  }

  async signInWithGoogle() {
    const { error } = await this.supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: environment.authCallbackUrl || `${environment.appUrl}/auth/callback`,
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
      redirectTo: environment.resetPasswordUrl || `${environment.appUrl}/auth/reset-password`
    });
    if (error) {
      console.error('AuthService: resetPassword error', error);
      throw error;
    }
  }
}

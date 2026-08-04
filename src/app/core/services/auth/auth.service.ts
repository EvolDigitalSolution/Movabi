import { Injectable, signal, inject } from '@angular/core';
import { SupabaseService } from '../supabase/supabase.service';
import { User, Session, AuthChangeEvent } from '@supabase/supabase-js';
import { Router, Route } from '@angular/router';
import { ProfileService } from '../profile/profile.service';
import { AccountStatus } from '@shared/models/booking.model';
import { environment } from '@env/environment';
import { Capacitor } from '@capacitor/core';
import { Browser } from '@capacitor/browser';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ApiUrlService } from '../api-url.service';

@Injectable({
    providedIn: 'root'
})
export class AuthService {
    private supabase = inject(SupabaseService);
    private router = inject(Router);
    public profileService = inject(ProfileService);
    private http = inject(HttpClient);
    private apiUrl = inject(ApiUrlService);

    currentUser = signal<User | null>(null);
    session = signal<Session | null>(null);
    isAuthReady = signal(false);
    userRole = signal<string | null>(null);
    onboardingCompleted = signal<boolean>(false);
    tenantId = signal<string | null>(null);
    accountStatus = signal<AccountStatus>('active');
    stripeConnectStatus = signal<'not_started' | 'pending' | 'restricted' | 'enabled' | 'connected'>('not_started');

    private redirecting = false;

    constructor() {
        void this.init();
    }

    private async init() {
        if (!this.supabase.isConfigured) {
            this.isAuthReady.set(true);
            return;
        }

        try {
            const { data: { session } } = await this.supabase.auth.getSession();
            await this.handleAuthStateChange('INITIAL_SESSION', session);

            this.supabase.auth.onAuthStateChange((event, session) => {
                void this.handleAuthStateChange(event, session);
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
            this.markReturningUser();
            const profile = await this.profileService.fetchProfile(user.id);

            if (profile) {
                this.userRole.set(profile.role);
                this.onboardingCompleted.set(profile.onboarding_completed);
                this.tenantId.set(profile.tenant_id);
                this.accountStatus.set(profile.account_status || 'active');
                this.stripeConnectStatus.set(profile.stripe_connect_status || 'not_started');
            } else {
                this.userRole.set(user.user_metadata?.['role'] || null);
                this.onboardingCompleted.set(user.user_metadata?.['onboarding_completed'] || false);
                this.tenantId.set(user.user_metadata?.['tenant_id'] || null);
                this.accountStatus.set('active');
                this.stripeConnectStatus.set('not_started');
            }
        } else {
            this.clearLocalAuthState(false);
        }

        this.isAuthReady.set(true);

        if (event === 'PASSWORD_RECOVERY') {
            await this.safeNavigate(['/auth/reset-password', '/reset-password', '/auth/login']);
            return;
        }
    }

    private getRedirectUrl(path: string): string {
        if (Capacitor.isNativePlatform()) {
            const cleanPath = path.startsWith('/') ? path.slice(1) : path;
            return `com.movabi.app://${cleanPath}`;
        }

        const currentOrigin = typeof window !== 'undefined' ? window.location.origin : '';
        const isLocalApp = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(currentOrigin);

        if (isLocalApp) {
            const cleanPath = path.startsWith('/') ? path : `/${path}`;
            return `${currentOrigin}${cleanPath}`;
        }

        if (path === '/auth/callback' && environment.authCallbackUrl) {
            return environment.authCallbackUrl;
        }

        if (path === '/auth/reset-password' && environment.resetPasswordUrl) {
            return environment.resetPasswordUrl;
        }

        const origin = currentOrigin || environment.appUrl || 'http://localhost:3000';
        const cleanOrigin = origin.endsWith('/') ? origin.slice(0, -1) : origin;
        const cleanPath = path.startsWith('/') ? path : `/${path}`;

        return `${cleanOrigin}${cleanPath}`;
    }

    async signUp(email: string, password: string, data?: Record<string, unknown>) {
        const result = await firstValueFrom(this.http.post<{ user: User | null; session: Session | null }>(this.apiUrl.getApiUrl('/api/auth/register'), {
            email, password, data,
            countryCode: data?.['country_code'], marketCity: data?.['market_city'],
            emailRedirectTo: this.getRedirectUrl('/auth/callback')
        }));
        if (result.session?.access_token && result.session.refresh_token) {
            await this.supabase.auth.setSession({ access_token: result.session.access_token, refresh_token: result.session.refresh_token });
        }

        localStorage.setItem('movabi_returning_user', 'true');
        return result;
    }

    async signIn(email: string, password: string) {
        const { data: result, error } = await this.supabase.auth.signInWithPassword({
            email,
            password
        });

        if (error) throw error;

        this.markReturningUser();

        await this.handleAuthStateChange('SIGNED_IN', result.session);
        await this.handlePostAuthRedirect();

        return result;
    }

    async signInWithGoogle() {
        const isNative = Capacitor.isNativePlatform();

        const { data, error } = await this.supabase.auth.signInWithOAuth({
            provider: 'google',
            options: {
                redirectTo: this.getRedirectUrl('/auth/callback'),
                skipBrowserRedirect: isNative,
                queryParams: {
                    access_type: 'offline',
                    prompt: 'consent'
                }
            }
        });

        if (error) throw error;

        if (isNative && data.url) {
            await Browser.open({ url: data.url, presentationStyle: 'fullscreen' });
        }
    }

    async completeOAuthCallback(code: string): Promise<void> {
        const { data, error } = await this.supabase.auth.exchangeCodeForSession(code);

        if (error) throw error;

        await this.handleAuthStateChange('SIGNED_IN', data.session);
        this.markReturningUser();
    }

    async completeOAuthHashCallback(accessToken: string, refreshToken: string): Promise<void> {
        const { data, error } = await this.supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken
        });

        if (error) throw error;

        await this.handleAuthStateChange('SIGNED_IN', data.session);
        this.markReturningUser();
    }

    async signOut() {
        try {
            const { error } = await this.supabase.auth.signOut();
            if (error) throw error;
        } finally {
            this.clearLocalAuthState(true);
            await this.safeNavigate(['/auth/login', '/login']);
        }
    }

    async resetPassword(email: string) {
        const { error } = await this.supabase.auth.resetPasswordForEmail(email, {
            redirectTo: this.getRedirectUrl('/auth/reset-password')
        });

        if (error) throw error;
    }

    async handlePostAuthRedirect(): Promise<void> {
        if (this.redirecting) return;

        this.redirecting = true;

        try {
            const { data: { session } } = await this.supabase.auth.getSession();

            if (!this.currentUser() && session) {
                await this.handleAuthStateChange('INITIAL_SESSION', session);
            }

            const user = this.currentUser();

            if (!user) {
                await this.safeNavigate(['/auth/login', '/login']);
                return;
            }

            let profile = this.profileService.profile();

            if (!profile || profile.id !== user.id) {
                profile = await this.profileService.fetchProfile(user.id);
            }

            const status = profile?.account_status || this.accountStatus() || 'active';

            if (status !== 'active') {
                await this.safeNavigate(['/auth/blocked', '/blocked', '/auth/login']);
                return;
            }

            const role = String(profile?.role || this.userRole() || '').toLowerCase();
            const onboardingCompleted = profile?.onboarding_completed ?? this.onboardingCompleted();

            if (!role) {
                await this.safeNavigate(['/auth/role-selection', '/role-selection', '/auth/login']);
                return;
            }

            if (!onboardingCompleted) {
                if (role === 'driver') {
                    await this.safeNavigate(['/driver/onboarding', '/onboarding', '/auth/role-selection']);
                    return;
                }

                if (role === 'customer') {
                    await this.safeNavigate(['/customer/onboarding', '/onboarding', '/auth/role-selection']);
                    return;
                }

                if (role === 'admin') {
                    await this.safeNavigate(['/dashboard', '/admin', '/auth/role-selection']);
                    return;
                }

                await this.safeNavigate(['/auth/role-selection', '/role-selection', '/auth/login']);
                return;
            }

            if (role === 'admin') {
                await this.safeNavigate(['/dashboard', '/admin', '/auth/role-selection']);
                return;
            }

            if (role === 'driver') {
                await this.safeNavigate(['/driver/dashboard', '/driver', '/tabs/driver', '/auth/role-selection']);
                return;
            }

            if (role === 'customer') {
                await this.safeNavigate(['/customer/home', '/customer', '/tabs/customer', '/auth/role-selection']);
                return;
            }

            await this.safeNavigate(['/auth/role-selection', '/role-selection', '/auth/login']);
        } catch (error) {
            console.error('Error during post-auth redirect:', error);
            await this.safeNavigate(['/auth/login', '/login']);
        } finally {
            this.redirecting = false;
        }
    }

    private async safeNavigate(paths: string[]) {
        const currentPath = this.router.url.split('?')[0].split('#')[0];

        for (const path of paths) {
            if (!path) continue;
            if (currentPath === path) return;
            if (!this.routeExists(path)) continue;

            try {
                await this.router.navigateByUrl(path, { replaceUrl: true });
                return;
            } catch (error) {
                console.warn(`[AuthService] Route failed: ${path}`, error);
            }
        }

        console.warn('[AuthService] No safe route matched:', paths);
    }

    private routeExists(path: string): boolean {
        const cleanPath = path.replace(/^\/+/, '').split('?')[0].split('#')[0];

        if (!cleanPath) return true;

        return this.matchRoutes(this.router.config, cleanPath.split('/'));
    }

    private matchRoutes(routes: Route[], segments: string[]): boolean {
        for (const route of routes) {
            const routePath = route.path || '';

            if (routePath === '**') continue;

            if (routePath === '') {
                if (route.children && this.matchRoutes(route.children, segments)) return true;
                if (route.loadChildren) return true;
                continue;
            }

            const routeParts = routePath.split('/').filter(Boolean);

            if (routeParts.length > segments.length) continue;

            const matches = routeParts.every((part, index) =>
                part.startsWith(':') || part === segments[index]
            );

            if (!matches) continue;

            const remaining = segments.slice(routeParts.length);

            if (remaining.length === 0) return true;

            if (route.children && this.matchRoutes(route.children, remaining)) return true;
            if (route.loadChildren) return true;
        }

        return false;
    }

    private clearLocalAuthState(clearSession: boolean) {
        if (clearSession) {
            this.session.set(null);
            this.currentUser.set(null);
        }

        this.userRole.set(null);
        this.onboardingCompleted.set(false);
        this.tenantId.set(null);
        this.accountStatus.set('active');
        this.stripeConnectStatus.set('not_started');
        this.profileService.profile.set(null);
    }

    private markReturningUser(): void {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem('movabi_returning_user', 'true');
    }
}

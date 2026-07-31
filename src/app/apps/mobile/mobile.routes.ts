import { Routes } from '@angular/router';
import { authGuard } from '@core/guards/auth.guard';
import { roleGuard } from '@core/guards/role.guard';

export const MOBILE_ROUTES: Routes = [
    {
        path: '',
        loadComponent: () => import('@mobile/features/landing.page').then((m) => m.LandingPage)
    },
    {
        path: 'landing',
        loadComponent: () => import('@mobile/features/landing.page').then((m) => m.LandingPage)
    },
    {
        path: 'privacy',
        loadComponent: () => import('@mobile/features/legal/privacy.page').then((m) => m.PrivacyPage)
    },
    {
        path: 'help',
        loadComponent: () => import('@mobile/features/help/help.page').then((m) => m.HelpPage)
    },
    {
        path: 'about-movabi',
        loadComponent: () =>
            import('@admin/features/landing/movabi-about.component').then((m) => m.AdminMovabiAboutComponent)
    },
    {
        path: 'how-to-use',
        redirectTo: 'help',
        pathMatch: 'full'
    },
    {
        path: 'dashboard',
        redirectTo: 'admin/dashboard',
        pathMatch: 'full'
    },
    {
        path: 'admin',
        loadChildren: () => import('@admin/admin-web.routes').then((m) => m.ADMIN_WEB_ROUTES)
    },
    {
        path: 'auth',
        loadComponent: () => import('@shared/ui/router-outlet.component').then((m) => m.RouterOutletComponent),
        children: [
            {
                path: 'login',
                loadComponent: () => import('@mobile/features/auth/login.page').then((m) => m.LoginPage)
            },
            {
                path: 'signup',
                loadComponent: () => import('@mobile/features/auth/signup.page').then((m) => m.SignupPage)
            },
            {
                path: 'forgot-password',
                loadComponent: () => import('@mobile/features/auth/forgot-password.page').then((m) => m.ForgotPasswordPage)
            },
            {
                path: 'reset-password',
                loadComponent: () => import('@mobile/features/auth/reset-password.page').then((m) => m.ResetPasswordPage)
            },
            {
                path: 'callback',
                loadComponent: () => import('@mobile/features/auth/callback.page').then((m) => m.AuthCallbackPage)
            },
            {
                path: 'role-selection',
                canActivate: [authGuard],
                loadComponent: () => import('@mobile/features/auth/role-selection.page').then((m) => m.RoleSelectionPage)
            },
            {
                path: 'blocked',
                loadComponent: () => import('@mobile/features/auth/blocked.page').then((m) => m.BlockedPage)
            }
        ]
    },
    {
        path: 'customer/onboarding',
        canActivate: [authGuard],
        loadComponent: () => import('@mobile/features/customer/onboarding/onboarding.page').then((m) => m.CustomerOnboardingPage)
    },
    {
        path: 'account/settings',
        canActivate: [authGuard],
        loadComponent: () => import('@mobile/features/account/account-settings.page').then((m) => m.AccountSettingsPage)
    },
    {
        path: 'driver/onboarding',
        canActivate: [authGuard],
        loadComponent: () => import('@mobile/features/driver/onboarding/onboarding.page').then((m) => m.OnboardingPage)
    },
    {
        path: 'driver/dashboard',
        redirectTo: 'driver',
        pathMatch: 'full'
    },
    {
        path: 'driver/requests',
        redirectTo: 'driver',
        pathMatch: 'full'
    },
    {
        path: 'customer/home',
        redirectTo: 'customer',
        pathMatch: 'full'
    },
    {
        path: 'customer',
        canActivate: [authGuard, roleGuard],
        data: { role: 'customer' },
        loadComponent: () => import('@shared/ui/router-outlet.component').then((m) => m.RouterOutletComponent),
        children: [
            {
                path: '',
                loadComponent: () => import('@mobile/features/customer/home.page').then((m) => m.HomePage)
            },
            {
                path: 'request',
                loadComponent: () => import('@mobile/features/customer/booking-request/booking-request.page').then((m) => m.BookingRequestPage)
            },
            {
                path: 'tracking/:id',
                loadComponent: () => import('@mobile/features/customer/booking-tracking/booking-tracking.page').then((m) => m.BookingTrackingPage)
            },
            {
                path: 'marketplace-fare/:id',
                loadComponent: () => import('@mobile/features/customer/marketplace-fare/marketplace-fare.page').then((m) => m.MarketplaceFarePage)
            },
            {
                path: 'marketplace-payment/:id',
                loadComponent: () => import('@mobile/features/customer/marketplace-payment/marketplace-payment.page').then((m) => m.MarketplacePaymentPage)
            },
            {
                path: 'services',
                loadComponent: () => import('@mobile/features/customer/services/services.page').then((m) => m.ServicesPage)
            },
            {
                path: 'activity',
                loadComponent: () => import('@mobile/features/customer/activity/activity.page').then((m) => m.ActivityPage)
            },
            {
                path: 'wallet',
                loadComponent: () => import('@mobile/features/customer/wallet/wallet.page').then((m) => m.WalletPage)
            },
            {
                path: 'van-moving',
                children: [
                    {
                        path: 'create',
                        loadComponent: () => import('@mobile/features/customer/van-moving/create-job.page').then((m) => m.CreateJobPage)
                    },
                    {
                        path: 'status/:id',
                        loadComponent: () => import('@mobile/features/customer/van-moving/job-status.page').then((m) => m.JobStatusPage)
                    }
                ]
            }
        ]
    },
    {
        path: 'driver',
        canActivate: [authGuard, roleGuard],
        data: { role: 'driver' },
        loadComponent: () => import('@shared/ui/router-outlet.component').then((m) => m.RouterOutletComponent),
        children: [
            {
                path: '',
                loadComponent: () => import('@mobile/features/driver/dashboard/dashboard.page').then((m) => m.DriverDashboardPage)
            },
            {
                path: 'van-moving',
                loadComponent: () => import('@mobile/features/driver/van-moving/van-jobs.page').then((m) => m.VanJobsPage)
            },
            {
                path: 'job-details/:id',
                loadComponent: () => import('@mobile/features/driver/job-details/job-details.page').then((m) => m.JobDetailsPage)
            },
            {
                path: 'earnings',
                loadComponent: () => import('@mobile/features/driver/earnings/earnings.page').then((m) => m.EarningsPage)
            },
            {
                path: 'hybrid-negotiation/:id',
                loadComponent: () => import('@mobile/features/driver/hybrid-negotiation/hybrid-negotiation.page').then((m) => m.DriverHybridNegotiationPage)
            },
            {
                path: 'subscription',
                loadComponent: () => import('@mobile/features/driver/subscription/subscription.page').then((m) => m.SubscriptionPage)
            },
            {
                path: 'settings',
                loadComponent: () => import('@mobile/features/driver/settings.page').then((m) => m.DriverSettingsPage)
            }
        ]
    }
];

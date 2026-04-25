import { Routes } from '@angular/router';
import { authGuard } from '@core/guards/auth.guard';
import { roleGuard } from '@core/guards/role.guard';

export const ADMIN_WEB_ROUTES: Routes = [

    // 🔥 FIX: redirect /admin → /dashboard
    {
        path: 'admin',
        redirectTo: 'dashboard',
        pathMatch: 'full'
    },

    {
        path: 'auth',
        children: [
            {
                path: 'login',
                loadComponent: () =>
                    import('@mobile/features/auth/login.page')
                        .then(m => m.LoginPage)
            }
        ]
    },

    {
        path: '',
        canActivate: [authGuard, roleGuard],
        data: { role: 'admin' },
        loadComponent: () =>
            import('@admin/features/layout/admin-layout.component')
                .then(m => m.AdminLayoutComponent),

        children: [
            {
                path: 'dashboard',
                loadComponent: () =>
                    import('@admin/features/dashboard/dashboard.component')
                        .then(m => m.AdminDashboardComponent)
            },
            {
                path: 'users',
                loadComponent: () =>
                    import('@admin/features/users/user-list.component')
                        .then(m => m.UserListComponent)
            },
            {
                path: 'drivers',
                loadComponent: () =>
                    import('@admin/features/drivers/driver-list.component')
                        .then(m => m.DriverListComponent)
            },
            {
                path: 'bookings',
                loadComponent: () =>
                    import('@admin/features/bookings/booking-list.component')
                        .then(m => m.BookingListComponent)
            },
            {
                path: 'pricing',
                loadComponent: () =>
                    import('@admin/features/pricing/pricing-rules.component')
                        .then(m => m.PricingRulesComponent)
            },
            {
                path: 'subscriptions',
                loadComponent: () =>
                    import('@admin/features/subscriptions/subscription-plans.component')
                        .then(m => m.SubscriptionPlansComponent)
            },
            {
                path: 'active-subscriptions',
                loadComponent: () =>
                    import('@admin/features/subscriptions/subscription-list.component')
                        .then(m => m.SubscriptionListComponent)
            },
            {
                path: 'driver-subscriptions',
                loadComponent: () =>
                    import('@admin/features/subscriptions/driver-subscriptions.component')
                        .then(m => m.DriverSubscriptionsComponent)
            },
            {
                path: 'van-jobs',
                loadComponent: () =>
                    import('@admin/features/jobs/job-monitoring.component')
                        .then(m => m.JobMonitoringComponent)
            },
            {
                path: 'settings',
                loadComponent: () =>
                    import('@admin/features/settings/settings.component')
                        .then(m => m.AdminSettingsComponent)
            },

            // 🔥 default inside admin
            {
                path: '',
                redirectTo: 'dashboard',
                pathMatch: 'full'
            }
        ]
    },

    // 🔥 GLOBAL fallback (VERY IMPORTANT)
    {
        path: '**',
        redirectTo: 'dashboard'
    }
];
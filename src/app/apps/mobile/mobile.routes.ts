import { Routes } from '@angular/router';
import { authGuard } from '@core/guards/auth.guard';
import { roleGuard } from '@core/guards/role.guard';

export const MOBILE_ROUTES: Routes = [
  {
    path: '',
    redirectTo: 'customer',
    pathMatch: 'full'
  },
  {
    path: 'auth',
    children: [
      {
        path: 'login',
        loadComponent: () => import('@mobile/features/auth/login.page').then(m => m.LoginPage)
      }
    ]
  },
  {
    path: 'customer',
    canActivate: [authGuard, roleGuard],
    data: { role: 'customer' },
    children: [
      {
        path: '',
        loadComponent: () => import('@mobile/features/customer/home.page').then(m => m.HomePage)
      },
      {
        path: 'request',
        loadComponent: () => import('@mobile/features/customer/booking-request/booking-request.page').then(m => m.BookingRequestPage)
      },
      {
        path: 'tracking/:id',
        loadComponent: () => import('@mobile/features/customer/booking-tracking/booking-tracking.page').then(m => m.BookingTrackingPage)
      },
      {
        path: 'activity',
        loadComponent: () => import('@mobile/features/customer/activity/activity.page').then(m => m.ActivityPage)
      },
      {
        path: 'van-moving',
        children: [
          {
            path: 'create',
            loadComponent: () => import('@mobile/features/customer/van-moving/create-job.page').then(m => m.CreateJobPage)
          },
          {
            path: 'status/:id',
            loadComponent: () => import('@mobile/features/customer/van-moving/job-status.page').then(m => m.JobStatusPage)
          }
        ]
      }
    ]
  },
  {
    path: 'driver',
    canActivate: [authGuard, roleGuard],
    data: { role: 'driver' },
    children: [
      {
        path: '',
        loadComponent: () => import('@mobile/features/driver/dashboard/dashboard.page').then(m => m.DriverDashboardPage)
      },
      {
        path: 'van-moving',
        loadComponent: () => import('@mobile/features/driver/van-moving/van-jobs.page').then(m => m.VanJobsPage)
      },
      {
        path: 'onboarding',
        loadComponent: () => import('@mobile/features/driver/onboarding/onboarding.page').then(m => m.OnboardingPage)
      },
      {
        path: 'job-details/:id',
        loadComponent: () => import('@mobile/features/driver/job-details/job-details.page').then(m => m.JobDetailsPage)
      },
      {
        path: 'earnings',
        loadComponent: () => import('@mobile/features/driver/earnings/earnings.page').then(m => m.EarningsPage)
      },
      {
        path: 'subscription',
        loadComponent: () => import('@mobile/features/driver/subscription/subscription.page').then(m => m.SubscriptionPage)
      }
    ]
  }
];

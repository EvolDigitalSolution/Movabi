import { APP_BASE_HREF } from '@angular/common';
import { provideHttpClient, withInterceptorsFromDi } from '@angular/common/http';
import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  APP_INITIALIZER,
} from '@angular/core';
import {provideRouter, withComponentInputBinding} from '@angular/router';
import {provideIonicAngular} from '@ionic/angular/standalone';
import {MOBILE_ROUTES} from './mobile.routes';
import { PricingConfigService } from '../../core/services/pricing/pricing-config.service';

export const mobileConfig: ApplicationConfig = {
  providers: [
    { provide: APP_BASE_HREF, useValue: '/' },
    provideHttpClient(withInterceptorsFromDi()),
    provideBrowserGlobalErrorListeners(),
    provideRouter(MOBILE_ROUTES, withComponentInputBinding()),
    provideIonicAngular({}),
    {
      provide: APP_INITIALIZER,
      useFactory: (pricingService: PricingConfigService) => () => pricingService.loadPricingConfigs(),
      deps: [PricingConfigService],
      multi: true
    }
  ],
};

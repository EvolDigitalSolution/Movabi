import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  APP_INITIALIZER,
} from '@angular/core';
import {provideRouter} from '@angular/router';
import {provideIonicAngular} from '@ionic/angular/standalone';
import {ADMIN_WEB_ROUTES} from './admin-web.routes';
import { PricingConfigService } from '../../core/services/pricing/pricing-config.service';

export const adminConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(ADMIN_WEB_ROUTES),
    provideIonicAngular({}),
    {
      provide: APP_INITIALIZER,
      useFactory: (pricingService: PricingConfigService) => () => pricingService.loadPricingConfigs(),
      deps: [PricingConfigService],
      multi: true
    }
  ],
};

import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import {provideRouter} from '@angular/router';
import {provideIonicAngular} from '@ionic/angular/standalone';
import {MOBILE_ROUTES} from './mobile.routes';

export const mobileConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(MOBILE_ROUTES),
    provideIonicAngular({})
  ],
};

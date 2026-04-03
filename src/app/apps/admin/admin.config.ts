import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import {provideRouter} from '@angular/router';
import {provideIonicAngular} from '@ionic/angular/standalone';
import {ADMIN_WEB_ROUTES} from './admin-web.routes';

export const adminConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(ADMIN_WEB_ROUTES),
    provideIonicAngular({})
  ],
};

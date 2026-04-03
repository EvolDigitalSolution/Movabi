import {bootstrapApplication} from '@angular/platform-browser';
import {App} from './app/app';
import {mobileConfig} from './app/apps/mobile/mobile.config';

bootstrapApplication(App, mobileConfig).catch((err) => console.error(err));

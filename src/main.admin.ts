import {bootstrapApplication} from '@angular/platform-browser';
import {AdminWebComponent} from './app/apps/admin/admin-web.component';
import {adminConfig} from './app/apps/admin/admin.config';

bootstrapApplication(AdminWebComponent, adminConfig).catch((err) => console.error(err));

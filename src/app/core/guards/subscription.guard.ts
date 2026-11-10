import { Injectable } from '@angular/core';
import { CanActivate } from '@angular/router';

/** Compatibility guard: subscription is optional and affects commission only.
 * Authentication, role, compliance and acquisition checks remain authoritative.
 */
@Injectable({providedIn:'root'})
export class SubscriptionGuard implements CanActivate {
  canActivate():boolean {return true;}
}

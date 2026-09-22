import { Injectable, inject, signal } from '@angular/core';
import { SupabaseService } from '../supabase/supabase.service';
import { Profile, DriverProfile } from '@shared/models/booking.model';

/**
 * Batch 2C Phase B — compliance-controlled profile columns.
 *
 * These columns carry approval / verification / review STATE. The server owns
 * them, through the authenticated onboarding route
 * (`POST /api/driver-onboarding/submit-review`) and the requireAdmin-guarded
 * `/api/verification/*` review routes. No client code may write them, so the
 * shared generic profile writer drops every field in this list instead of
 * sending it.
 *
 * The list is deliberately an ALLOW-BY-EXCEPTION deny-list of exactly the state
 * columns that have no legitimate client-side writer. `role`, `account_status`,
 * `verification_items` and ordinary profile fields are NOT included, because
 * legitimate self-service flows still use them and their closure belongs to the
 * Phase C policy.
 *
 * APPLICATION HARDENING ONLY: `public.profiles` still has no RLS and no
 * column-level UPDATE revoke, so a hand-crafted HTTP request can still bypass
 * this client guard. Phase C closes the database boundary.
 */
export const COMPLIANCE_CONTROLLED_PROFILE_FIELDS = [
    'is_verified',
    'verification_status',
    'verification_blockers',
    'driver_review_status',
    'driver_review_blockers',
    'compliance_status',
    'testing_approval_override',
    'driver_license_status',
    'insurance_status',
    'private_hire_driver_license_status',
    'private_hire_vehicle_license_status',
    'private_hire_insurance_status'
] as const;

export interface StrippedComplianceFields {
    /** The payload with every compliance-controlled field removed. */
    payload: Record<string, unknown>;
    /** The field names that were removed, for logging and tests. */
    dropped: string[];
}

/**
 * Remove compliance-controlled fields from a generic profile update payload.
 * Pure, so it can be tested directly and reused by any profile writer.
 */
export function stripComplianceControlledFields(updates: Record<string, unknown>): StrippedComplianceFields {
    const payload: Record<string, unknown> = {};
    const dropped: string[] = [];

    for (const [key, value] of Object.entries(updates ?? {})) {
        if ((COMPLIANCE_CONTROLLED_PROFILE_FIELDS as readonly string[]).includes(key)) {
            dropped.push(key);
            continue;
        }
        payload[key] = value;
    }

    return { payload, dropped };
}

@Injectable({
  providedIn: 'root'
})
export class ProfileService {
  private supabase = inject(SupabaseService);

  profile = signal<Profile | null>(null);

  async fetchProfile(userId: string): Promise<Profile | null> {
    if (!userId || userId === 'undefined' || userId === 'null') {
      console.warn('Profile fetch skipped because user id is missing.');
      return null;
    }

    const { data, error } = await this.supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      console.error('Error fetching profile:', error);
      return null;
    }

    if (!data) {
      console.warn('Profile not found for user:', userId);
      return null;
    }

    this.profile.set(data);
    return data;
  }

  async fetchDriverProfile(userId: string): Promise<DriverProfile | null> {
    const { data, error } = await this.supabase
      .from('profiles')
      .select('*, vehicles(*)')
      .eq('id', userId)
      .maybeSingle();

    if (error) {
      console.error('Error fetching driver profile:', error);
      return null;
    }

    return data;
  }

  async updateProfile(userId: string, updates: Partial<Profile>): Promise<Profile | null> {
    // Batch 2C Phase B: the generic profile writer can never carry compliance
    // state. Approval/verification/review columns are server-owned.
    const { payload, dropped } = stripComplianceControlledFields(updates as Record<string, unknown>);
    if (dropped.length) {
      console.error(
        '[ProfileService] Refused to write server-owned compliance fields from the client:',
        dropped.join(', ')
      );
    }
    if (!Object.keys(payload).length) return this.profile();

    const { data, error } = await this.supabase
      .from('profiles')
      .update(payload)
      .eq('id', userId)
      .select()
      .maybeSingle();

    if (error) throw error;
    
    if (data) {
      this.profile.set(data);
    }
    
    return data;
  }

  async getRole(userId: string): Promise<string | null> {
    const { data, error } = await this.supabase
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .maybeSingle();

    if (error || !data) return null;
    return data.role;
  }

  async syncSubscriptionStatus(userId: string, status: string) {
    const { error } = await this.supabase
      .from('profiles')
      .update({ subscription_status: status })
      .eq('id', userId);

    if (error) throw error;
  }
}

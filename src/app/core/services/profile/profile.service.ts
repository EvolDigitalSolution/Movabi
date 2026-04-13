import { Injectable, inject, signal } from '@angular/core';
import { SupabaseService } from '../supabase/supabase.service';
import { Profile, DriverProfile } from '@shared/models/booking.model';

@Injectable({
  providedIn: 'root'
})
export class ProfileService {
  private supabase = inject(SupabaseService);

  profile = signal<Profile | null>(null);

  async fetchProfile(userId: string): Promise<Profile | null> {
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
    const { data, error } = await this.supabase
      .from('profiles')
      .update(updates)
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

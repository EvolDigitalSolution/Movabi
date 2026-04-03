import { Injectable, inject, signal, effect } from '@angular/core';
import { SupabaseService } from '../supabase/supabase.service';
import { Profile, DriverProfile } from '@shared/models/booking.model';
import { AuthService } from '../auth/auth.service';

@Injectable({
  providedIn: 'root'
})
export class ProfileService {
  private supabase = inject(SupabaseService);
  private auth = inject(AuthService);

  profile = signal<Profile | null>(null);

  constructor() {
    // Sync profile when auth state changes
    effect(() => {
      const user = this.auth.currentUser();
      if (user) {
        this.fetchProfile(user.id);
      } else {
        this.profile.set(null);
      }
    });
  }

  async fetchProfile(userId: string): Promise<Profile | null> {
    const { data, error } = await this.supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (error) {
      console.error('Error fetching profile:', error);
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
      .single();

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
      .single();

    if (error) throw error;
    
    if (this.profile()?.id === userId) {
      this.profile.set(data);
    }
    
    return data;
  }

  async getRole(userId: string): Promise<string | null> {
    const { data, error } = await this.supabase
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .single();

    if (error) return null;
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

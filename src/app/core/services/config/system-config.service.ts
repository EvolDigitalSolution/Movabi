import { Injectable, inject, signal } from '@angular/core';
import { SupabaseService } from '../supabase/supabase.service';

export interface SystemConfig {
  id?: string;
  key: string;
  value: unknown;
  updated_at?: string;
}

@Injectable({
  providedIn: 'root'
})
export class SystemConfigService {
  private supabase = inject(SupabaseService);
  
  private configs = signal<Record<string, unknown>>({});

  async loadConfigs() {
    const { data, error } = await this.supabase
      .from('system_configs')
      .select('*');
    
    if (error) {
      console.error('Error loading system configs:', error);
      return;
    }

    const configMap: Record<string, unknown> = {};
    data?.forEach(c => {
      configMap[c.key] = c.value;
    });
    this.configs.set(configMap);
  }

  getConfig<T>(key: string, defaultValue: T): T {
    return (this.configs()[key] as T) ?? defaultValue;
  }

  async setConfig(key: string, value: unknown) {
    const { error } = await this.supabase
      .from('system_configs')
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    
    if (error) throw error;
    
    this.configs.update(prev => ({ ...prev, [key]: value }));
  }
}

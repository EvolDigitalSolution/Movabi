import { Injectable } from '@angular/core';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { environment } from '@env/environment';

@Injectable({
  providedIn: 'root'
})
export class SupabaseService {
  private _client: SupabaseClient | null = null;

  get isConfigured(): boolean {
    return !!environment.supabaseUrl && !!environment.supabaseAnonKey;
  }

  get client(): SupabaseClient {
    if (!this._client) {
      if (!this.isConfigured) {
        // Return a proxy that logs errors instead of crashing the app
        console.warn('Supabase is not configured. Please set SUPABASE_URL and SUPABASE_ANON_KEY in your environment.');
        return this.createMockClient();
      }
      this._client = createClient(
        environment.supabaseUrl,
        environment.supabaseAnonKey
      );
    }
    return this._client;
  }

  private createMockClient(): SupabaseClient {
    const handler = {
      get: (_target: unknown, prop: string) => {
        if (prop === 'auth') {
          return {
            getSession: () => Promise.resolve({ data: { session: null }, error: null }),
            onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => { /* empty */ } } } }),
            signInWithPassword: () => Promise.reject(new Error('Supabase not configured')),
            signUp: () => Promise.reject(new Error('Supabase not configured')),
            signOut: () => Promise.resolve({ error: null }),
          };
        }
        return () => {
          console.error(`Supabase method "${prop}" called but Supabase is not configured.`);
          return {
            select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: new Error('Supabase not configured') }) }) }),
            insert: () => Promise.resolve({ data: null, error: new Error('Supabase not configured') }),
            update: () => Promise.resolve({ data: null, error: new Error('Supabase not configured') }),
            delete: () => Promise.resolve({ data: null, error: new Error('Supabase not configured') }),
          };
        };
      }
    };
    return new Proxy({}, handler) as SupabaseClient;
  }

  constructor() { /* empty */ }

  get auth() {
    return this.client.auth;
  }

  get storage() {
    return this.client.storage;
  }

  channel(name: string) {
    return this.client.channel(name);
  }

  from(table: string) {
    return this.client.from(table);
  }
}

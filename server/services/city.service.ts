import { supabaseAdmin } from './supabase.service';

export interface CityConfig {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radius_km: number;
  is_active: boolean;
  base_surge_multiplier: number;
  country_code?: string | null;
  country?: string | null;
}

export class CityService {
  /**
   * True when a PostgREST error means the `cities.is_active` column is absent.
   * 42703 is undefined_column; the message check covers differently-shaped errors.
   */
  static isMissingIsActiveColumn(error: unknown): boolean {
    const value = (error && typeof error === 'object' ? error : {}) as Record<string, unknown>;
    if (String(value['code'] ?? '') === '42703') return true;
    return /is_active/i.test(String(value['message'] ?? ''));
  }

  /**
   * Get all active cities.
   *
   * The committed `cities` DDL defines only id/name/country/lat/lng/radius_km/created_at --
   * there is no `is_active` column and no migration adds one. The filtered query therefore
   * fails with 42703 on such a schema, and this method used to rethrow. Because the quote
   * route calls findCityForLocation() at its very top (before the market-capability gate and
   * before any pricing lookup), that throw aborted the whole request -- so a valid GB journey
   * could never obtain a fare, no matter that the GB market is live with quote enabled.
   *
   * The activity filter is now treated as OPTIONAL: it is applied whenever the column exists
   * and skipped when it does not. This preserves deactivation wherever it is supported, never
   * invents a column, and keeps every market/country restriction intact (the city is only a
   * country hint; it authorises nothing on its own).
   */
  static async getActiveCities(): Promise<CityConfig[]> {
    const filtered = await supabaseAdmin
      .from('cities')
      .select('*')
      .eq('is_active', true);

    if (!filtered.error) return filtered.data || [];

    if (!this.isMissingIsActiveColumn(filtered.error)) throw filtered.error;

    console.warn('[CityService] cities.is_active is not available on this schema; reading cities without the activity filter');
    const unfiltered = await supabaseAdmin.from('cities').select('*');
    if (unfiltered.error) throw unfiltered.error;
    return unfiltered.data || [];
  }

  /**
   * Find the city for a given location
   */
  static async findCityForLocation(lat: number, lng: number): Promise<CityConfig | null> {
    const cities = await this.getActiveCities();
    
    for (const city of cities) {
      const distance = this.calculateDistance(lat, lng, city.lat, city.lng);
      if (distance <= (city.radius_km || 50)) {
        return city;
      }
    }

    return null;
  }

  /**
   * Helper to calculate distance in KM
   */
  private static calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371; // Radius of the earth in km
    const dLat = this.deg2rad(lat2 - lat1);
    const dLon = this.deg2rad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.deg2rad(lat1)) * Math.cos(this.deg2rad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private static deg2rad(deg: number): number {
    return deg * (Math.PI / 180);
  }
}

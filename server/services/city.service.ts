import { supabaseAdmin } from './supabase.service';

export interface CityConfig {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radius_km: number;
  is_active: boolean;
  base_surge_multiplier: number;
}

export class CityService {
  /**
   * Get all active cities
   */
  static async getActiveCities(): Promise<CityConfig[]> {
    const { data, error } = await supabaseAdmin
      .from('cities')
      .select('*')
      .eq('is_active', true);

    if (error) throw error;
    return data || [];
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

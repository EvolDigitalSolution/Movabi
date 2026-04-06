import { supabaseAdmin } from './supabase.service';

export class LogisticsService {
  private static readonly EARTH_RADIUS_KM = 6371;

  /**
   * Calculate distance between two points using Haversine formula
   */
  static calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return this.EARTH_RADIUS_KM * c;
  }

  private static toRad(value: number): number {
    return (value * Math.PI) / 180;
  }

  /**
   * Calculate price based on distance
   */
  static calculatePrice(distanceKm: number): number {
    const baseFee = 20;
    const ratePerKm = 2.5;
    const price = baseFee + (distanceKm * ratePerKm);
    return Math.round(price * 100) / 100; // Round to 2 decimal places
  }

  /**
   * Calculate payout breakdown for a job
   */
  static calculatePayout(totalPrice: number, pricingPlan: 'starter' | 'pro', commissionRate: number = 15.00) {
    // SOURCE OF TRUTH: 10% platform fee from customer
    const serviceFee = Math.round(totalPrice * 0.10 * 100) / 100; 
    const baseFare = totalPrice - serviceFee;
    
    let commissionFee = 0;
    let driverPayout = 0;

    if (pricingPlan === 'pro') {
      // Pro Plan: 0% commission from driver
      commissionFee = 0;
      driverPayout = baseFare;
    } else {
      // Starter Plan: Pay as you earn (commission applies to base fare)
      commissionFee = Math.round(baseFare * (commissionRate / 100) * 100) / 100;
      driverPayout = baseFare - commissionFee;
    }

    const platformFee = Math.round((serviceFee + commissionFee) * 100) / 100;

    return {
      total_price: totalPrice,
      base_fare: baseFare,
      service_fee: serviceFee,
      commission_fee: commissionFee,
      commission_rate_used: commissionRate,
      platform_fee: platformFee,
      driver_payout: driverPayout,
      pricing_plan_used: pricingPlan
    };
  }

  /**
   * Find nearest drivers within a tenant
   */
  static async findNearestDrivers(lat: number, lon: number, tenantId: string, limit = 5) {
    // Fetch drivers with recent location (last 5 minutes)
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const { data: locations, error } = await supabaseAdmin
      .from('driver_locations')
      .select('*, driver:profiles(*)')
      .eq('tenant_id', tenantId)
      .gt('updated_at', fiveMinutesAgo);

    if (error) throw error;

    const candidates = locations.map(loc => {
      const distance = this.calculateDistance(lat, lon, loc.lat, loc.lng);
      return {
        ...loc,
        distance
      };
    });

    // Sort by distance and return top N
    return candidates
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);
  }

  /**
   * Fetch driver profile details
   */
  static async findDriverProfile(driverId: string) {
    return await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', driverId)
      .single();
  }
}

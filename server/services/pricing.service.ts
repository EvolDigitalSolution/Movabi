export class PricingService {
  /**
   * Calculate surge multiplier based on demand and supply
   * @param demand Number of active searching jobs in the area
   * @param supply Number of available drivers in the area
   */
  static getSurgeMultiplier(demand: number, supply: number): number {
    if (supply === 0) return 2.0;

    const ratio = demand / supply;

    if (ratio > 3) return 2.0;
    if (ratio > 2) return 1.6;
    if (ratio > 1.5) return 1.3;
    if (ratio > 1.2) return 1.1;

    return 1.0;
  }

  /**
   * Simple ETA calculation
   * @param distanceKm Distance in kilometers
   * @param avgSpeedKmh Average speed in km/h (default 25 for city)
   */
  static calculateETA(distanceKm: number, avgSpeedKmh: number = 25): number {
    if (distanceKm <= 0) return 0;
    return Math.ceil((distanceKm / avgSpeedKmh) * 60);
  }
}

import { describe, expect, it } from 'vitest';
import { cleanServiceTypePayload } from './admin-pricing-payload';

describe('AdminService pricing/service payload hygiene', () => {
  it('normalizes service type payloads before admin writes them', () => {
    const clean = cleanServiceTypePayload({
      name: '  Package Delivery  ',
      slug: ' delivery ',
      description: ' Bike, car, or van delivery ',
      icon: '',
      base_price: '2.25',
      price_per_km: '0.55'
    });

    expect(clean).toEqual({
      name: 'Package Delivery',
      slug: 'delivery',
      description: 'Bike, car, or van delivery',
      icon: 'cube',
      base_price: 2.25,
      price_per_km: 0.55
    });
  });

  it('guards numeric admin pricing fields from missing values', () => {
    const clean = cleanServiceTypePayload({
      name: 'Ride',
      slug: 'ride'
    });

    expect(clean['base_price']).toBe(0);
    expect(clean['price_per_km']).toBe(0);
  });
});

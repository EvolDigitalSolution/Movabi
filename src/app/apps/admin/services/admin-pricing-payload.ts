export interface CleanServiceTypePayload {
  name: string;
  slug: string;
  description: string;
  icon: string;
  base_price: number;
  price_per_km: number;
}

export function cleanServiceTypePayload(payload: Record<string, unknown> | null | undefined): CleanServiceTypePayload {
  return {
    name: String(payload?.['name'] || '').trim(),
    slug: String(payload?.['slug'] || '').trim(),
    description: String(payload?.['description'] || '').trim(),
    icon: String(payload?.['icon'] || 'cube').trim() || 'cube',
    base_price: Number(payload?.['base_price'] || 0),
    price_per_km: Number(payload?.['price_per_km'] || 0)
  };
}

import { createHmac, timingSafeEqual } from 'crypto';
export interface JourneyGrant { jobId: string; driverId: string; tenantId: string; expires: number; }
export const ACTIVE_JOURNEY_STATUSES = new Set(['assigned','accepted','heading_to_pickup','over_budget_requested','delivered','en_route','en_route_to_pickup','arrived','arrived_at_pickup','arrived_at_store','shopping_in_progress','shopping_completed','items_collected','collected','en_route_to_customer','arrived_at_customer','in_progress','on_trip']);
function sign(payload: string, secret: string): string {
  if (!secret) throw new Error('Journey signing key is unavailable');
  return createHmac('sha256', secret).update('movabi-journey-v1:' + payload).digest('base64url');
}
export function issueJourneyGrant(grant: JourneyGrant, secret: string): string {
  const payload = Buffer.from(JSON.stringify(grant)).toString('base64url');
  return payload + '.' + sign(payload, secret);
}
export function verifyJourneyGrant(token: string, secret: string, now = Date.now()): JourneyGrant | null {
  try {
    const parts = token.split('.'); if (parts.length !== 2 || token.length > 2048) return null;
    const expected = Buffer.from(sign(parts[0], secret)); const supplied = Buffer.from(parts[1]);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
    const value = JSON.parse(Buffer.from(parts[0], 'base64url').toString()) as JourneyGrant;
    if (![value.jobId,value.driverId,value.tenantId].every(x => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x))) return null;
    if (!Number.isFinite(value.expires) || value.expires <= now || value.expires > now + 6 * 3600000) return null;
    return value;
  } catch { return null; }
}
export function parseJourneyPoint(body: Record<string, unknown>, now = Date.now()) {
  const lat = body.latitude; const lng = body.longitude; const time = body.time; const accuracy = body.accuracy;
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat)>90 || Math.abs(lng)>180 || (Math.abs(lat)<0.00001 && Math.abs(lng)<0.00001)) return null;
  if (typeof time !== 'number' || !Number.isFinite(time) || time < now-90000 || time > now+30000) return null;
  if (typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy<0 || accuracy>100) return null;
  const heading = typeof body.bearing==='number' && Number.isFinite(body.bearing) && body.bearing>=0 && body.bearing<360 ? body.bearing : null;
  const speed = typeof body.speed==='number' && Number.isFinite(body.speed) && body.speed>=0 && body.speed<100 ? body.speed : null;
  return {lat,lng,heading,speed,updated_at:new Date(time).toISOString()};
}

import {expect,it} from 'vitest';
import {hasActiveCommissionSubscription as active} from '../../server/services/subscription-policy.service';
const now=Date.parse('2026-10-15T12:00:00Z');
it('recognises a verified active paid period',()=>expect(active('active','2026-11-15T12:00:00Z',now)).toBe(true));
it('supports active billing records without a supplied period end',()=>expect(active('active',null,now)).toBe(true));
it.each(['inactive','past_due','canceled','trialing'])('does not waive commission for %s',status=>expect(active(status,'2026-11-15T12:00:00Z',now)).toBe(false));
it('expires the benefit at the period boundary',()=>expect(active('active','2026-10-15T12:00:00Z',now)).toBe(false));
it('rejects malformed period evidence',()=>expect(active('active','invalid',now)).toBe(false));

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MARKET_CODE_FALLBACK_COPY, marketCopyForCapability } from '../../server/services/market-availability.service';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const service = read('server/services/market-availability.service.ts');

/** What resolveMarket yields for a live GB row carrying configured unavailable copy. */
const LIVE_ROW_COPY = { title: 'Movabi is coming to Manchester', message: 'Bookings are not available in this area yet.' };

describe('market copy — a live market must not advertise unavailability for an ALLOWED capability', () => {
  it('strips the misleading copy when the capability is allowed on a live market', () => {
    expect(marketCopyForCapability('live', true, null, LIVE_ROW_COPY)).toEqual({ title: null, message: null });
  });

  it('never emits "coming to" / "not available" for a live allowed capability', () => {
    const copy = marketCopyForCapability('live', true, null, LIVE_ROW_COPY);
    expect(String(copy.title ?? '')).not.toContain('coming to');
    expect(String(copy.message ?? '')).not.toContain('not available');
  });

  it('preserves configured copy for a live market whose capability is DISABLED', () => {
    // The startup banner relies on this: NG is live with bookings disabled and must still
    // be able to show its configured message.
    expect(marketCopyForCapability('live', false, 'MARKET_CAPABILITY_DISABLED', LIVE_ROW_COPY))
      .toEqual({ title: 'Movabi is coming to Manchester', message: 'Bookings are not available in this area yet.' });
  });

  it('preserves configured copy for coming_soon and paused markets', () => {
    expect(marketCopyForCapability('coming_soon', false, 'MARKET_COMING_SOON', LIVE_ROW_COPY)).toEqual(LIVE_ROW_COPY);
    expect(marketCopyForCapability('paused', false, 'MARKET_PAUSED', LIVE_ROW_COPY)).toEqual(LIVE_ROW_COPY);
  });

  it('does not strip copy for a non-live market even if the capability were allowed', () => {
    expect(marketCopyForCapability('coming_soon', true, null, LIVE_ROW_COPY)).toEqual(LIVE_ROW_COPY);
    expect(marketCopyForCapability('paused', true, null, LIVE_ROW_COPY)).toEqual(LIVE_ROW_COPY);
  });

  it('backfills a truthful reason when a rejection has no message', () => {
    const empty = { title: null, message: null };
    const copy = marketCopyForCapability('live', false, 'MARKET_CAPABILITY_DISABLED', empty);
    expect(copy.message).toBe(MARKET_CODE_FALLBACK_COPY.MARKET_CAPABILITY_DISABLED);
    expect(copy.title).toBe(MARKET_CODE_FALLBACK_COPY.MARKET_CAPABILITY_DISABLED);
  });

  it('keeps an existing message when backfilling is unnecessary', () => {
    const partial = { title: null, message: 'Custom reason' };
    expect(marketCopyForCapability('live', false, 'MARKET_PAUSED', partial).message).toBe('Custom reason');
  });

  it('provides truthful copy for every rejection code', () => {
    for (const code of ['MARKET_COMING_SOON', 'MARKET_PAUSED', 'MARKET_CAPABILITY_DISABLED', 'MARKET_LOCATION_UNRESOLVED', 'MARKET_NOT_CONFIGURED']) {
      const message = MARKET_CODE_FALLBACK_COPY[code];
      expect(message, code).toBeTruthy();
      expect(message).not.toContain('undefined');
    }
  });
});

describe('market copy — wiring', () => {
  it('the decision lives in checkCapability, where allowability is known', () => {
    expect(service).toContain('const copy=marketCopyForCapability(market.launchStatus,allowed,code,market);');
    expect(service).toContain('const resolved={...market,...copy};');
    expect(service).toContain('return {allowed,market:resolved,code};');
  });

  it('resolveMarket keeps configured copy so GET /markets/status still drives the banner', () => {
    expect(service).toContain('title:row.unavailable_title||`Movabi is coming to ${marketCity||countryCode}`');
    expect(service).not.toContain('...marketCopyFor(String(row.launch_status)');
  });

  it('the audit row records the resolved market', () => {
    expect(service).toContain('country_code:resolved.countryCode');
    expect(service).toContain('error_code:code');
  });

  it('the authoritative 422/403 distinction is unchanged', () => {
    expect(service).toContain("const status=result.code==='MARKET_LOCATION_UNRESOLVED'?422:403;");
  });

  it('the title/message contract permits null', () => {
    expect(service).toContain('title:string|null; message:string|null;');
  });
});

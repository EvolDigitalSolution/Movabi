import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Area 1c (2026-11-13): `jobs.no_driver_reason` is shown to the CUSTOMER verbatim on the tracking page
 * (e2e/customer-no-driver-reason.spec.ts). It must always be fixed server text, never a driver's own
 * words: `/driver-unable` used to write "Previous driver could not continue: <driver's reason>".
 * The driver's reason stays in metadata.driver_handoff_history for admins.
 */
const files = ['server/routes/booking.routes.ts', 'server/services/dispatch.service.ts'];
describe('customer-visible no_driver_reason is server text only', () => {
  for (const f of files) {
    it(f, () => {
      const src = readFileSync(join(process.cwd(), f), 'utf8');
      const writes = [...src.matchAll(/no_driver_reason\s*:\s*(null|'[^'\n]*'|`[^`]*`|[^,\n})]+)/g)].map((m) => m[1].trim());
      expect(writes.length).toBeGreaterThan(0);
      for (const w of writes) expect(w, `${f}: ${w}`).toMatch(/^(null|'[^'$`]*')$/);
    });
  }
  it('dispatch reasons are the ones the tracking page test expects', () => {
    const src = readFileSync(join(process.cwd(), 'server/services/dispatch.service.ts'), 'utf8')
      + readFileSync(join(process.cwd(), 'server/routes/booking.routes.ts'), 'utf8');
    for (const text of ['No eligible drivers are nearby right now.', 'Drivers nearby are currently busy — retrying shortly.',
      'The booking offer timed out before a driver accepted.', 'Your previous driver could not continue. Finding another driver.'])
      expect(src).toContain(text);
  });
});

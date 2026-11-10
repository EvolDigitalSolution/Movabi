import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const cwd = process.cwd();
const hash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

function executedSteps(): string[] {
  const src = readFileSync(join(cwd, 'src/testing/bike-authenticated-routes.integration.spec.ts'), 'utf8');
  const m = src.match(/for \(const migration of \[([\s\S]*?)\]\) \{/);
  if (!m) throw new Error('executed migration array not found');
  return [...m[1].matchAll(/'([^']+\.sql)'/g)].map((x) => x[1]);
}

describe('manifest drift guard', () => {
  it('packaged ORDER.txt matches the executed list exactly', () => {
    const order = readFileSync(join(cwd, 'deploy/vaydu-develop-validation/ORDER.txt'), 'utf8')
      .trim().split(/\r?\n/).filter(Boolean);
    expect(order, 'ORDER.txt diverges from the executed migration array').toEqual(executedSteps());
  });

  it('packaged SHA256SUMS migration entries match the executed files', () => {
    const sums = readFileSync(join(cwd, 'deploy/vaydu-develop-validation/SHA256SUMS'), 'utf8')
      .trim().split(/\r?\n/).filter(Boolean);
    const expected: string[] = [];
    for (const s of executedSteps()) {
      const file = join(cwd, s.startsWith('candidate/') ? `supabase/baseline/${s}` : `supabase/migrations/${s}`);
      expected.push(`${hash(file)}  migrations/${s.split('/').pop()}`);
    }
    const migrationSums = sums.filter((l) => l.includes('  migrations/'));
    expect(migrationSums, 'SHA256SUMS diverges from executed files').toEqual(expected);
  });
});

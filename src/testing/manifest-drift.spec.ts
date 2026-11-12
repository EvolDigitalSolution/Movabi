import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

// Drift guard for the develop release migration artefacts.
//
// History: this guarded deploy/vaydu-develop-validation (frozen at 35b2590), a package that applied the
// whole roadmap chain to develop. The 2026-11-12 reconciliation against develop's live schema
// (scripts/release/reconcile-live-schema.sh) showed develop already has 42 of those migrations; only
// 7 are pending. That package is therefore SUPERSEDED (see its README) and must not be refreshed into
// something that looks deployable. The artefacts that ship are deploy/vaydu-develop-release/*.sql,
// generated from the migration files; they must never drift from the files they are built from.
const cwd = process.cwd();
const hash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const release = join(cwd, 'deploy/vaydu-develop-release');

describe('manifest drift guard', () => {
  it('release-up/dryrun/down.sql are exactly what the generator builds from the current migration files', () => {
    const out = mkdtempSync(join(tmpdir(), 'vaydu-release-'));
    try {
      execFileSync(process.execPath, [join(cwd, 'scripts/release/build-release-sql.cjs')], { env: { ...process.env, VAYDU_RELEASE_OUT: out }, stdio: 'pipe' });
      for (const f of ['release-up.sql', 'release-dryrun.sql', 'release-down.sql', 'RELEASE-MIGRATIONS.sha256'])
        expect(hash(join(out, f)), `${f} differs from a fresh build`).toBe(hash(join(release, f)));
    } finally { rmSync(out, { recursive: true, force: true }); }
  });

  it('the committed checksum list matches the committed release files', () => {
    for (const line of readFileSync(join(release, 'RELEASE-MIGRATIONS.sha256'), 'utf8').trim().split(/\r?\n/)) {
      const [sum, file] = line.split(/\s+/);
      expect(hash(join(release, file!)), file).toBe(sum);
    }
  });

  it('the release is one transaction and the dry run ends in ROLLBACK', () => {
    const up = readFileSync(join(release, 'release-up.sql'), 'utf8');
    const dry = readFileSync(join(release, 'release-dryrun.sql'), 'utf8');
    for (const [name, text, end] of [['up', up, 'COMMIT;'], ['dryrun', dry, 'ROLLBACK;']] as const) {
      expect((text.match(/^[ \t]*(BEGIN|COMMIT|ROLLBACK)[ \t]*;[ \t]*\r?$/gm) ?? []).map(s => s.trim()), name).toEqual(['BEGIN;', end]);
      expect(text.trimEnd().endsWith(end), name).toBe(true);
    }
  });

  it('the superseded whole-chain validation package is marked as such', () => {
    expect(readFileSync(join(cwd, 'deploy/vaydu-develop-validation/README.md'), 'utf8')).toContain('SUPERSEDED');
  });
});

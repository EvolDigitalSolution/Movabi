import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chunkInClauseIds, DEFAULT_IN_CLAUSE_BATCH_SIZE } from '../app/shared/utils/chunk-ids';

const adminService = readFileSync(resolve(process.cwd(), 'src/app/apps/admin/services/admin.service.ts'), 'utf8');

describe('chunkInClauseIds', () => {
    it('returns no chunks for an empty/undefined list', () => {
        expect(chunkInClauseIds([])).toEqual([]);
        expect(chunkInClauseIds(null)).toEqual([]);
        expect(chunkInClauseIds(undefined)).toEqual([]);
    });

    it('deduplicates IDs preserving first-seen order', () => {
        expect(chunkInClauseIds(['a', 'b', 'a', 'c', 'b'])).toEqual([['a', 'b', 'c']]);
    });

    it('drops falsy entries', () => {
        expect(chunkInClauseIds(['a', '', null, undefined, 'b'])).toEqual([['a', 'b']]);
    });

    it('returns one chunk when size <= batch', () => {
        const ids = Array.from({ length: DEFAULT_IN_CLAUSE_BATCH_SIZE }, (_, i) => `id-${i}`);
        expect(chunkInClauseIds(ids)).toEqual([ids]);
    });

    it('splits into multiple bounded chunks when > batch', () => {
        const ids = Array.from({ length: 55 }, (_, i) => `id-${i}`);
        const chunks = chunkInClauseIds(ids);
        expect(chunks.length).toBe(3);
        expect(chunks[0].length).toBe(25);
        expect(chunks[1].length).toBe(25);
        expect(chunks[2].length).toBe(5);
        expect(chunks.every(c => c.length <= DEFAULT_IN_CLAUSE_BATCH_SIZE)).toBe(true);
    });

    it('never produces a giant single IN list for 250 IDs', () => {
        const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);
        const chunks = chunkInClauseIds(ids);
        expect(chunks.length).toBe(10);
        expect(chunks.every(c => c.length <= 25)).toBe(true);
        expect(chunks.flat().length).toBe(250);
    });

    it('flattening chunks preserves order and deduplication', () => {
        const ids = Array.from({ length: 60 }, (_, i) => `id-${i % 30}`);
        const chunks = chunkInClauseIds(ids);
        expect(chunks.flat()).toEqual(Array.from({ length: 30 }, (_, i) => `id-${i}`));
    });
});

describe('admin errand enrichment batching', () => {
    it('uses the bounded chunk helper for IN-list fetches', () => {
        expect(adminService).toContain('chunkInClauseIds');
        expect(adminService).toContain('private async fetchByIds');
        expect(adminService).toContain("service_slug === 'errand'");
    });

    it('no longer sends the raw unbounded jobIds list to the errand tables', () => {
        expect(adminService).not.toContain("await this.supabase.from('errand_details').select('*').in('job_id', jobIds)");
        expect(adminService).not.toContain("await this.supabase.from('errand_funding').select('*').in('job_id', jobIds)");
    });
});

export const DEFAULT_IN_CLAUSE_BATCH_SIZE = 25;

/**
 * Deduplicate and chunk an IN-clause ID list so PostgREST URLs stay bounded.
 * Preserves first-seen order while dropping duplicates and falsy entries.
 */
export function chunkInClauseIds<T>(ids: T[] | null | undefined, batchSize = DEFAULT_IN_CLAUSE_BATCH_SIZE): T[][] {
    const unique: T[] = [];
    const seen = new Set<T>();
    for (const id of ids ?? []) {
        if (id === null || id === undefined || (id as unknown) === '') continue;
        if (seen.has(id)) continue;
        seen.add(id);
        unique.push(id);
    }

    const chunks: T[][] = [];
    for (let i = 0; i < unique.length; i += batchSize) {
        chunks.push(unique.slice(i, i + batchSize));
    }
    return chunks;
}

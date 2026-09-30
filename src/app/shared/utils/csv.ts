/**
 * CSV export helpers (Admin).
 *
 * Pure serialisation (csvCell / buildCsv / toCsv) is separated from the browser
 * download trigger (downloadCsv) so the escaping logic can be unit-tested in a
 * Node environment without DOM/Blob APIs.
 */

/** Escape a single CSV field per RFC 4180 (commas, quotes, line breaks). */
export function csvCell(value: unknown): string {
    if (value === null || value === undefined) return '';
    const text = String(value);
    if (/[",\n\r]/.test(text)) {
        return '"' + text.replace(/"/g, '""') + '"';
    }
    return text;
}

/** Serialise rows (array of arrays) to a CSV string with CRLF line endings. */
export function buildCsv(rows: unknown[][]): string {
    return rows
        .map((row) => row.map(csvCell).join(','))
        .join('\r\n');
}

/** Build a CSV string from a header row plus data rows. */
export function toCsv(headers: string[], rows: unknown[][]): string {
    return buildCsv([headers, ...rows]);
}

/** A stable, human-friendly date stamp for export filenames (YYYY-MM-DD). */
export function csvDateStamp(now: Date = new Date()): string {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * Trigger a browser download of a CSV string.
 * UTF-8 safe (prepends a BOM for Excel), revokes the object URL afterwards.
 */
export function downloadCsv(filename: string, csv: string): void {
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
}

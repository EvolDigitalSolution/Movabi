import { describe, expect, it } from 'vitest';
import { buildCsv, csvCell, csvDateStamp, toCsv } from '../app/shared/utils/csv';

describe('CSV serialisation helpers', () => {
    it('leaves plain values untouched', () => {
        expect(csvCell('plain')).toBe('plain');
        expect(csvCell('hello world')).toBe('hello world');
        expect(csvCell(123)).toBe('123');
        expect(csvCell(0)).toBe('0');
        expect(csvCell(false)).toBe('false');
    });

    it('normalises null/undefined to empty cells', () => {
        expect(csvCell(null)).toBe('');
        expect(csvCell(undefined)).toBe('');
    });

    it('escapes commas by quoting the whole field', () => {
        expect(csvCell('a,b')).toBe('"a,b"');
    });

    it('escapes quotes by doubling them and quoting the field', () => {
        expect(csvCell('say "hi"')).toBe('"say ""hi"""');
        expect(csvCell('"already quoted"')).toBe('"""already quoted"""');
    });

    it('escapes line breaks by quoting the field', () => {
        expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
        expect(csvCell('line\rbreak')).toBe('"line\rbreak"');
    });

    it('serialises rows with CRLF line endings', () => {
        expect(buildCsv([['a', 'b'], ['c', 'd']])).toBe('a,b\r\nc,d');
        expect(buildCsv([['a', 'b,c'], ['say "hi"', null]])).toBe('a,"b,c"\r\n"say ""hi""",');
    });

    it('builds a header-first CSV via toCsv', () => {
        expect(toCsv(['Name', 'Email'], [['Ada', 'ada@x.com']])).toBe('Name,Email\r\nAda,ada@x.com');
    });

    it('produces a YYYY-MM-DD date stamp', () => {
        expect(csvDateStamp(new Date(2026, 0, 5))).toBe('2026-01-05');
    });
});

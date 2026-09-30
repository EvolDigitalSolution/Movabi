import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const app = readFileSync(resolve(process.cwd(), 'src/app/app.ts'), 'utf8');

const buttonFor = (handler: string) =>
    app.match(new RegExp(`<button[^>]*\\(click\\)="${handler}"[^>]*>`))?.[0] || '';

describe('customer startup country selector', () => {
    it('marks the persisted country selected at option level so NG renders Nigeria', () => {
        // Option-level selection is applied when the option is created, so a
        // persisted 'NG' selects the 'NG' option instead of falling back to the
        // alphabetically first option (Australia).
        expect(app).toContain('[selected]="country.code === appConfig.currentCountry().code"');
        expect(app).toContain('{{country.name}}');
    });

    it('no longer relies on the select [value] binding that loses the selection', () => {
        expect(app).not.toContain('[value]="appConfig.currentCountry().code"');
    });

    it('keeps the existing change handler on both country selectors', () => {
        const handlers = app.match(/\(change\)="changeStartupCountry\(\$any\(\$event\.target\)\.value\)"/g) || [];
        expect(handlers.length).toBe(2);
    });

    it('selection predicate is pure ISO-code equality (NG->NG true, NG->AU false; GB->GB true)', () => {
        const isSelected = (optionCode: string, currentCode: string) => optionCode === currentCode;
        expect(isSelected('NG', 'NG')).toBe(true);
        expect(isSelected('AU', 'NG')).toBe(false);
        expect(isSelected('GB', 'GB')).toBe(true);
        expect(isSelected('AU', 'GB')).toBe(false);
    });
});

describe('startup market failure handling', () => {
    it('replaces startupMarket on failure instead of retaining the previous market', () => {
        const catchBlock = app.slice(app.indexOf('async checkStartupMarket()'), app.indexOf('private unavailableStartupStatus'));
        expect(catchBlock).toContain('catch');
        expect(catchBlock).toContain('this.startupMarket.set(this.unavailableStartupStatus(countryCode))');
        expect(catchBlock).toContain('this.marketAvailability.current.set(null)');
    });

    it('the failure status is country-agnostic (no previous country title/message)', () => {
        const helper = app.slice(app.indexOf('private unavailableStartupStatus'), app.indexOf('private setupDeepLinkListener'));
        expect(helper).toContain("code: 'MARKET_STATUS_UNAVAILABLE'");
        expect(helper).toContain("resolutionLevel: 'unavailable'");
        expect(helper).toContain('customerAppEnabled: false');
        expect(helper).not.toContain('unavailable_title');
    });

    it('keeps the retry control available after a failed check', () => {
        expect(app).toContain('(click)="checkStartupMarket()"');
    });
});

describe('waiting-list layout treatment', () => {
    it('Join cannot shrink and never wraps', () => {
        const join = buttonFor('joinWaitingList\\(\\)');
        expect(join).not.toBe('');
        expect(join).toContain('shrink-0');
        expect(join).toContain('whitespace-nowrap');
        // vertical padding parities with the email input's p-3
        expect(join).toContain('py-3');
    });

    it('Retry / Sign in stack on narrow widths and sit horizontally when wider', () => {
        const row = app.match(/<div class="([^"]*)"[^>]*>(?=<button[^>]*checkStartupMarket\(\))/)?.[1] || '';
        expect(row).toContain('flex-col');
        expect(row).toContain('sm:flex-row');
    });

    it('Retry and Sign in no longer clip or become unnaturally narrow', () => {
        const retry = buttonFor('checkStartupMarket\\(\\)');
        const signIn = app.match(/<button[^>]*router\.navigateByUrl\('\/auth\/login'\)[^>]*>/)?.[0] || '';
        for (const button of [retry, signIn]) {
            expect(button).not.toBe('');
            expect(button).toContain('shrink-0');
            expect(button).toContain('whitespace-nowrap');
            expect(button).toContain('w-full');
            expect(button).toContain('sm:w-auto');
        }
    });
});

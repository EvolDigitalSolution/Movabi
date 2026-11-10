import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const app = read('src/app/app.ts');
const signup = read('src/app/apps/mobile/features/auth/signup.page.ts');

/**
 * The signup page owns the country dropdown while the root App owns the market
 * banner/overlay. They only share AppConfigService, so the root must react to
 * country changes itself -- previously a change updated the country but left the
 * previous country's market state on screen until a full page reload.
 */
describe('signup country change re-resolves market availability', () => {
    it('root App reacts to currentCountry changes reactively (no reload)', () => {
        expect(app).toContain('effect(');
        expect(app).toContain('this.appConfig.currentCountry().code');
        expect(app).toContain('void this.checkStartupMarket();');
        expect(app).not.toContain('location.reload');
        expect(app).not.toContain('window.location.reload');
    });

    it('the reactive effect does not duplicate the bootstrap request', () => {
        expect(app).toContain('private startupResolved = signal(false);');
        expect(app).toContain('if (!this.startupResolved()) return;');
        expect(app).toContain('this.startupResolved.set(true);');
    });

    it('a superseded response can never overwrite the newest country', () => {
        expect(app).toContain('private marketRequestSeq = 0;');
        expect(app).toContain('const seq = ++this.marketRequestSeq;');
        expect(app).toContain('if (seq !== this.marketRequestSeq) return;');
    });

    it('previous-country market state is dropped while the new country is pending', () => {
        const body = app.slice(app.indexOf('async checkStartupMarket()'), app.indexOf('private unavailableStartupStatus'));
        const clearIndex = body.indexOf('this.startupMarket.set(null);');
        const awaitIndex = body.indexOf('await this.marketAvailability.getStatus');
        expect(clearIndex).toBeGreaterThan(-1);
        expect(awaitIndex).toBeGreaterThan(-1);
        expect(clearIndex).toBeLessThan(awaitIndex);
    });

    it('signup country change persists the country and clears the country-specific city', () => {
        const handler = signup.slice(signup.indexOf('onCountryChange(event: Event)'), signup.indexOf('passwordMatchValidator(g: FormGroup)'));
        expect(handler).toContain('this.config.setCountry(code);');
        expect(handler).toContain("this.signupForm.patchValue({ marketCity: '' });");
        expect(handler).not.toContain('reload');
    });

    it('signup still submits the currently selected country', () => {
        expect(signup).toContain('country_code: this.config.currentCountry().code');
    });
});

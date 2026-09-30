import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');

/**
 * Ionic's normalize.css is an unlayered reset, and unlayered CSS outranks every
 * cascade layer. Its `button { padding: 0; border: 0; border-radius: 0; ... }`
 * used to silently defeat Tailwind's layered button utilities, collapsing every
 * native <button> in the app to its bare text width. These assertions lock in the
 * layer arrangement that keeps Tailwind in control.
 */
describe('Ionic normalize vs Tailwind cascade layers', () => {
    it('declares the ionic-normalize layer before Tailwind so Tailwind wins', () => {
        const layerStatement = styles.indexOf('@layer ionic-normalize;');
        const tailwindImport = styles.indexOf('@import "tailwindcss";');
        expect(layerStatement).toBeGreaterThan(-1);
        expect(tailwindImport).toBeGreaterThan(-1);
        expect(layerStatement).toBeLessThan(tailwindImport);
    });

    it('imports only normalize.css into the layer', () => {
        expect(styles).toContain('@import "@ionic/angular/css/normalize.css" layer(ionic-normalize);');
    });

    it('leaves every other Ionic stylesheet unlayered (no wider re-layering)', () => {
        const ionicImports = styles.match(/@import "@ionic\/angular\/css\/[^"]+"[^;]*;/g) || [];
        expect(ionicImports.length).toBeGreaterThan(1);
        const layered = ionicImports.filter((line) => line.includes('layer('));
        expect(layered).toEqual(['@import "@ionic/angular/css/normalize.css" layer(ionic-normalize);']);
    });

    it('does not reintroduce an unlayered button reset of its own', () => {
        // Every app-authored button rule must live inside a cascade layer.
        expect(styles).not.toMatch(/^\s*button\s*\{/m);
    });
});

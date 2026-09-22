/**
 * BATCH 2C — API STARTUP COMPILE GUARD.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The API container's CMD is
 *   npx ts-node --project server/tsconfig.json server/index.ts
 * so a TypeScript diagnostic anywhere in the `server/` project is a *runtime*
 * startup failure in production (the container exits 1), not a build warning.
 *
 * Commit 52f2de2 shipped three diagnostics that no existing spec could see:
 *   driver-onboarding.routes.ts(69,81)   TS2353 'passengerLicence' does not exist in the
 *                                        input type accepted by the called service
 *   driver-onboarding.routes.ts(169,104) TS2352 'DriverVehicleRow' to 'Record<string, unknown>'
 *   driver-onboarding.routes.ts(231,94)  TS2353 'passengerLicence' does not exist ...
 *
 * WHY THE PRE-EXISTING SUITE COULD NOT SEE THEM
 *   * `tsc -p tsconfig.app.json` does not compile `server/**` at all (Angular app project).
 *   * every spec that cares about a route reads it as *text* via `readFileSync`, so route
 *     modules were never part of any type-check graph;
 *   * ad-hoc `tsc --noEmit --strict ... <files>` runs used a different effective project
 *     (strict:true / module ESNext) than the container's server/tsconfig.json
 *     (strict:false / CommonJS / moduleResolution node);
 *   * the one compile that was run executed against the *working tree*, where an
 *     uncommitted change to driver-requirement.service.ts satisfied a call site that the
 *     commit did not contain. Verifying the worktree is not verifying the commit.
 *
 * WHAT THESE TESTS DO
 *   1. type-checks the real startup project (server/tsconfig.json) in-process with the
 *      TypeScript compiler API and requires zero diagnostics;
 *   2. pins the guard to the container's actual CMD so it cannot silently go vacuous;
 *   3. proves the guard has teeth by re-creating the 52f2de2 defect as an in-memory
 *      source override and requiring the compiler to report TS2353 and TS2352 again.
 *
 * No child process is spawned: the compiler API runs in-process, so this guard behaves
 * identically under the local sandbox and in CI.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';

const ROOT = process.cwd();
const SERVER_ROOT = resolve(ROOT, 'server');
const SERVER_TSCONFIG = resolve(SERVER_ROOT, 'tsconfig.json');
const DOCKERFILE = 'server/Dockerfile';
const ROUTE_REL = 'server/routes/driver-onboarding.routes.ts';
const REQUIREMENT_SERVICE_REL = 'server/services/driver-requirement.service.ts';

const read = (relative: string): string => readFileSync(resolve(ROOT, relative), 'utf8');

/** Resolve a path the same way the compiler host will, so overrides match reliably. */
function canonical(fileName: string): string {
    return resolve(fileName).replace(/\\/g, '/').toLowerCase();
}

function loadServerProject(): ts.ParsedCommandLine {
    const configFile = ts.readConfigFile(SERVER_TSCONFIG, ts.sys.readFile);
    if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, ' '));
    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, SERVER_ROOT);
    if (parsed.errors.length > 0) {
        throw new Error(parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, ' ')).join('; '));
    }
    return parsed;
}

const FORMAT_HOST: ts.FormatDiagnosticsHost = {
    getCanonicalFileName: fileName => fileName,
    getCurrentDirectory: () => ROOT,
    getNewLine: () => '\n'
};

/**
 * Type-check `server/tsconfig.json` exactly as the container's ts-node invocation does,
 * optionally substituting in-memory source text for named project files.
 */
function typeCheckServerProject(overrides: ReadonlyArray<readonly [string, string]> = []): readonly ts.Diagnostic[] {
    const parsed = loadServerProject();
    const options: ts.CompilerOptions = { ...parsed.options, noEmit: true };
    const host = ts.createCompilerHost(options, true);
    const replaced = new Map<string, string>();
    for (const [relative, text] of overrides) replaced.set(canonical(resolve(ROOT, relative)), text);
    if (replaced.size > 0) {
        const readFile = host.readFile.bind(host);
        const fileExists = host.fileExists.bind(host);
        const getSourceFile = host.getSourceFile.bind(host);
        host.readFile = fileName => replaced.get(canonical(fileName)) ?? readFile(fileName);
        host.fileExists = fileName => replaced.has(canonical(fileName)) || fileExists(fileName);
        host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
            const text = replaced.get(canonical(fileName));
            return text === undefined
                ? getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
                : ts.createSourceFile(fileName, text, languageVersion, true);
        };
    }
    const program = ts.createProgram({ rootNames: parsed.fileNames, options, host });
    return ts.getPreEmitDiagnostics(program);
}

function render(diagnostics: readonly ts.Diagnostic[]): string {
    return ts.formatDiagnostics(diagnostics, FORMAT_HOST).trim();
}

describe('BATCH 2C — API startup compile guard (production ts-node graph)', () => {
    it('1. the server startup project type-checks with zero diagnostics', () => {
        const diagnostics = typeCheckServerProject();
        expect(
            render(diagnostics),
            'server/tsconfig.json is the project the API container starts with; any diagnostic here is a production startup failure'
        ).toBe('');
    }, 300000);

    it('2. the guard is bound to the command the container actually runs', () => {
        const command = read(DOCKERFILE)
            .split(/\r?\n/)
            .find(line => /^\s*CMD\s/.test(line)) || '';
        expect(command, 'server/Dockerfile must keep a CMD line').not.toBe('');
        expect(command).toContain('"npx"');
        expect(command).toContain('"ts-node"');
        expect(command).toContain('"--project"');
        expect(command).toContain('"server/tsconfig.json"');
        expect(command).toContain('"server/index.ts"');
    });

    it('3. the guard has teeth: the 52f2de2 defect is still reported as TS2353 and TS2352', () => {
        const route = read(ROUTE_REL);
        const requirementService = read(REQUIREMENT_SERVICE_REL);

        // Production condition 1: the resolve() input type does not declare passengerLicence.
        const regressedService = requirementService.replace(/passengerLicence\??:\s*DriverPassengerLicence\s*;?/g, '');
        expect(
            /passengerLicence\??:\s*DriverPassengerLicence/.test(regressedService),
            'the mutated service input type must not declare passengerLicence'
        ).toBe(false);

        // Production condition 2: both resolve() call sites pass passengerLicence anyway,
        // and the eligibility call site uses the unsound DriverVehicleRow conversion.
        let regressedRoute = route;
        if (!/passengerLicence,vehicle:canonicalVehicle,/.test(regressedRoute)) {
            regressedRoute = regressedRoute.replace(
                'resolve({profile,canonicalProfile,vehicle:canonicalVehicle,',
                'resolve({profile,canonicalProfile,passengerLicence,vehicle:canonicalVehicle,'
            );
        }
        if (!/passengerLicence,vehicle:vehicleInput,/.test(regressedRoute)) {
            regressedRoute = regressedRoute.replace(
                'resolve({profile:profileInput,canonicalProfile,vehicle:vehicleInput,',
                'resolve({profile:profileInput,canonicalProfile,passengerLicence,vehicle:vehicleInput,'
            );
        }
        if (!/vehicleRow as Record<string,unknown>\|null/.test(regressedRoute)) {
            regressedRoute = regressedRoute.replace(
                'vehicle:vehicleRow?{...vehicleRow}:null',
                'vehicle:(vehicleRow as Record<string,unknown>|null)??null'
            );
        }
        expect(regressedRoute, 'both resolve() call sites must pass passengerLicence').toMatch(/passengerLicence,vehicle:canonicalVehicle,/);
        expect(regressedRoute, 'the submit-review call site must pass passengerLicence').toMatch(/passengerLicence,vehicle:vehicleInput,/);
        expect(regressedRoute, 'the eligibility call site must use the unsound conversion').toMatch(/vehicleRow as Record<string,unknown>\|null/);

        const diagnostics = typeCheckServerProject([
            [ROUTE_REL, regressedRoute],
            [REQUIREMENT_SERVICE_REL, regressedService]
        ]);
        const rows = diagnostics.map(diagnostic => ({
            code: diagnostic.code,
            line: diagnostic.file && diagnostic.start !== undefined
                ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1
                : -1,
            file: (diagnostic.file ? diagnostic.file.fileName : '').replace(/\\/g, '/').toLowerCase(),
            message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')
        }));
        const routeFile = canonical(resolve(ROOT, ROUTE_REL));
        const callSiteFailures = rows.filter(row =>
            row.code === 2353 && row.file === routeFile && row.message.includes('passengerLicence'));
        const castFailures = rows.filter(row =>
            row.code === 2352 && row.file === routeFile && row.message.includes('DriverVehicleRow'));

        expect(
            callSiteFailures.length,
            `both resolve() call sites must fail as in production (the service body adds its own TS2339), got:\n${render(diagnostics)}`
        ).toBe(2);
        expect(
            castFailures.length,
            `the unsound vehicle conversion must fail as in production, got:\n${render(diagnostics)}`
        ).toBe(1);
        expect(new Set(callSiteFailures.map(row => row.line)).size, 'the two call sites are distinct lines').toBe(2);
    }, 300000);
});

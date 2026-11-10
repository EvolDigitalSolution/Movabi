"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PASSENGER_LICENCE_CANONICAL_COLUMNS = void 0;
exports.parsePassengerLicenceDate = parsePassengerLicenceDate;
exports.passengerLicenceExpired = passengerLicenceExpired;
exports.parseDriverPassengerLicenceInput = parseDriverPassengerLicenceInput;
exports.passengerLicenceItems = passengerLicenceItems;
exports.readPassengerLicence = readPassengerLicence;
exports.passengerLicenceColumns = passengerLicenceColumns;
exports.passengerLicenceMirror = passengerLicenceMirror;
exports.mapDriverPassengerLicence = mapDriverPassengerLicence;
const text = (value) => {
    const result = typeof value === 'string' ? value.trim() : '';
    return result || null;
};
function parsePassengerLicenceDate(value) {
    const raw = text(value);
    if (!raw)
        throw new Error('Add a valid licence expiry date.');
    const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    const displayMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
    const iso = isoMatch ? raw : displayMatch ? `${displayMatch[3]}-${displayMatch[2]}-${displayMatch[1]}` : '';
    if (!iso)
        throw new Error('Add a valid licence expiry date.');
    const [year, month, day] = iso.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
        throw new Error('Add a valid licence expiry date.');
    }
    return iso;
}
function passengerLicenceExpired(expiryDate, now = new Date()) {
    const today = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
    return expiryDate < today;
}
function parseDriverPassengerLicenceInput(input, now = new Date()) {
    if (!input || typeof input !== 'object')
        throw new Error('Passenger licence details are required.');
    const body = input;
    const councilName = text(body.councilName);
    const licenceNumber = text(body.licenceNumber);
    const badgeNumber = text(body.badgeNumber);
    if (!councilName)
        throw new Error('Add your licensing authority.');
    if (!licenceNumber)
        throw new Error('Add your private hire licence number.');
    if (!badgeNumber)
        throw new Error('Add your taxi/private hire badge number.');
    const expiryDate = parsePassengerLicenceDate(body.expiryDate);
    if (passengerLicenceExpired(expiryDate, now))
        throw new Error('Your private hire licence has expired.');
    return { councilName, licenceNumber, badgeNumber, expiryDate };
}
/**
 * The canonical typed profile columns that store the passenger licence.
 * Batch 2C Phase B: these are the application source of truth.
 */
exports.PASSENGER_LICENCE_CANONICAL_COLUMNS = [
    'council_name',
    'council_license_number',
    'taxi_badge_number',
    'taxi_license_expiry'
];
/**
 * Tolerant compatibility-storage reader for `profiles.verification_items`.
 *
 * Accepts every shape the application itself writes or has written:
 *   * an object map                     {council_name: 'X'}
 *   * an array of {key,value} rows      [{key:'council_name', value:'X'}]
 *   * a JSON string of either of those  '{"council_name":"X"}'
 * Anything else (including arrays of non-row values) yields {}.
 *
 * Only the compatibility MIRROR is read here. It is never a compliance verdict.
 */
function passengerLicenceItems(input) {
    if (!input)
        return {};
    if (typeof input === 'string') {
        try {
            return passengerLicenceItems(JSON.parse(input));
        }
        catch {
            return {};
        }
    }
    if (Array.isArray(input)) {
        return input.reduce((items, entry) => {
            if (!entry || typeof entry !== 'object')
                return items;
            const row = entry;
            const key = String(row['key'] ?? row['name'] ?? '').trim();
            if (key)
                items[key] = row['value'];
            return items;
        }, {});
    }
    return typeof input === 'object' ? input : {};
}
/** First non-blank string, trimmed; null when none is usable. */
const firstText = (...candidates) => {
    for (const candidate of candidates) {
        const value = text(candidate);
        if (value)
            return value;
    }
    return null;
};
/**
 * CANONICAL-FIRST passenger-licence read.
 *
 * Precedence, identical to `public.driver_service_eligibility()`:
 *   1. the canonical typed profiles columns  (authoritative),
 *   2. the `verification_items` compatibility keys (legacy mirror),
 *   3. the legacy alias column.
 *
 * A present canonical value therefore always wins, so a stale compatibility
 * mirror can never override it. Compatibility storage is read only when the
 * canonical value is absent.
 *
 * EXPIRY FAILS SAFE: the first present expiry candidate is parsed, and a
 * malformed or impossible value resolves to null rather than falling through to
 * a lower-precedence candidate — the same shape as the SQL precedence, where a
 * non-blank canonical value is chosen first and then `safe_iso_date` may return
 * NULL. Expiry equal to today remains valid.
 */
function readPassengerLicence(profile, now = new Date()) {
    const row = profile ?? {};
    const items = passengerLicenceItems(row['verification_items']);
    const councilName = firstText(row['council_name'], items['council_name'], row['council_license_authority']);
    const licenceNumber = firstText(row['council_license_number'], items['council_license_number']);
    const badgeNumber = firstText(row['taxi_badge_number'], items['taxi_badge_number']);
    const expiryRaw = firstText(row['taxi_license_expiry'], items['taxi_license_expiry'], row['council_license_expiry']);
    let expiryDate = null;
    try {
        expiryDate = expiryRaw === null ? null : parsePassengerLicenceDate(expiryRaw);
    }
    catch {
        expiryDate = null;
    }
    const complete = !!councilName && !!licenceNumber && !!badgeNumber && !!expiryDate && !passengerLicenceExpired(expiryDate, now);
    return { councilName, licenceNumber, badgeNumber, expiryDate, status: complete ? 'complete' : 'incomplete', complete };
}
/**
 * The canonical column payload for a validated passenger-licence write.
 * Phase B persists these typed columns as the source of truth; the
 * `verification_items` mirror is maintained separately for compatibility.
 */
function passengerLicenceColumns(licence) {
    return {
        council_name: licence.councilName,
        council_license_number: licence.licenceNumber,
        taxi_badge_number: licence.badgeNumber,
        taxi_license_expiry: licence.expiryDate
    };
}
/** The compatibility mirror payload for a validated passenger-licence write. */
function passengerLicenceMirror(licence) {
    return {
        council_name: licence.councilName,
        council_license_number: licence.licenceNumber,
        taxi_badge_number: licence.badgeNumber,
        taxi_license_expiry: licence.expiryDate
    };
}
function mapDriverPassengerLicence(items, now = new Date()) {
    const councilName = text(items['council_name']);
    const licenceNumber = text(items['council_license_number']);
    const badgeNumber = text(items['taxi_badge_number']);
    let expiryDate = null;
    try {
        expiryDate = items['taxi_license_expiry'] == null ? null : parsePassengerLicenceDate(items['taxi_license_expiry']);
    }
    catch {
        expiryDate = null;
    }
    const complete = !!councilName && !!licenceNumber && !!badgeNumber && !!expiryDate && !passengerLicenceExpired(expiryDate, now);
    return { councilName, licenceNumber, badgeNumber, expiryDate, status: complete ? 'complete' : 'incomplete', complete };
}

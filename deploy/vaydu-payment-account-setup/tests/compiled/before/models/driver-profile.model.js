"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CANONICAL_DRIVER_PROFILE_SELECT = void 0;
exports.mapDriverProfile = mapDriverProfile;
exports.parseResidentialAddress = parseResidentialAddress;
exports.parseDriverPhone = parseDriverPhone;
exports.parseDriverDateOfBirth = parseDriverDateOfBirth;
exports.calculateCalendarAge = calculateCalendarAge;
exports.CANONICAL_DRIVER_PROFILE_SELECT = 'id,full_name,phone,date_of_birth,current_address,verification_status,updated_at';
const value = (input) => typeof input === 'string' && input.trim() ? input.trim() : null;
function mapDriverProfile(row, emailConfirmed) {
    return {
        id: row.id,
        fullName: value(row.full_name),
        phone: value(row.phone),
        dateOfBirth: value(row.date_of_birth),
        // Read compatibility: current_address is canonical, but legacy onboarding
        // also stored address_line1 / home_address. Use the first meaningful value
        // so a driver with a valid legacy address is not falsely blocked.
        residentialAddress: value(row.current_address) ?? value(row.address_line1) ?? value(row.home_address),
        emailConfirmed,
        verificationStatus: value(row.verification_status)
    };
}
function parseResidentialAddress(input) {
    const body = input && typeof input === 'object' ? input : {};
    const address = value(body['residentialAddress'] ?? body['currentAddress'] ?? body['current_address']);
    if (!address || address.length < 5)
        throw new Error('Enter a valid current residential address.');
    return address;
}
/**
 * Contact-number normalisation for `profiles.phone`.
 *
 * Only separators are removed (spaces, dashes, dots, parentheses). Digits are
 * never invented or altered and no verification is implied: the driver
 * requirement for `profile.phone` checks PRESENCE only. An unusable value is
 * rejected rather than silently coerced into something that looks valid.
 */
function parseDriverPhone(input) {
    const raw = value(input);
    if (!raw)
        throw new Error('Add your contact number.');
    const normalized = raw.replace(/[\s().-]/g, '');
    if (!/^\+?\d{7,15}$/.test(normalized))
        throw new Error('Enter a valid contact number.');
    return normalized;
}
function parseDriverDateOfBirth(input, now = new Date()) {
    const raw = value(input);
    if (!raw)
        throw new Error('Add your date of birth.');
    let year, month, day;
    let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (match) {
        year = Number(match[1]);
        month = Number(match[2]);
        day = Number(match[3]);
    }
    else {
        match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
        if (!match)
            throw new Error('Enter a valid date of birth.');
        day = Number(match[1]);
        month = Number(match[2]);
        year = Number(match[3]);
    }
    const candidate = new Date(Date.UTC(year, month - 1, day));
    if (year < 1900 || candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) {
        throw new Error('Enter a valid date of birth.');
    }
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    if (candidate.getTime() > today)
        throw new Error('Date of birth cannot be in the future.');
    return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}
function calculateCalendarAge(isoDateOfBirth, now = new Date()) {
    const [year, month, day] = isoDateOfBirth.split('-').map(Number);
    let age = now.getUTCFullYear() - year;
    if (now.getUTCMonth() + 1 < month || (now.getUTCMonth() + 1 === month && now.getUTCDate() < day))
        age--;
    return age;
}

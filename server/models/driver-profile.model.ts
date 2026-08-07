export const CANONICAL_DRIVER_PROFILE_SELECT =
  'id,full_name,phone,date_of_birth,current_address,verification_status,updated_at';

export interface DriverProfileRow {
  id: string;
  full_name?: string | null;
  phone?: string | null;
  date_of_birth?: string | null;
  current_address?: string | null;
  verification_status?: string | null;
  updated_at?: string | null;
}

export interface CanonicalDriverProfile {
  id: string;
  fullName: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  residentialAddress: string | null;
  emailConfirmed: boolean;
  verificationStatus: string | null;
}

const value = (input: unknown): string | null =>
  typeof input === 'string' && input.trim() ? input.trim() : null;

export function mapDriverProfile(row: DriverProfileRow, emailConfirmed: boolean): CanonicalDriverProfile {
  return {
    id: row.id,
    fullName: value(row.full_name),
    phone: value(row.phone),
    dateOfBirth: value(row.date_of_birth),
    residentialAddress: value(row.current_address),
    emailConfirmed,
    verificationStatus: value(row.verification_status)
  };
}

export function parseResidentialAddress(input: unknown): string {
  const body = input && typeof input === 'object' ? input as { [key: string]: unknown } : {};
  const address = value(body['residentialAddress'] ?? body['currentAddress'] ?? body['current_address']);
  if (!address || address.length < 5) throw new Error('Enter a valid current residential address.');
  return address;
}

export function parseDriverDateOfBirth(input: unknown, now = new Date()): string {
  const raw = value(input);
  if (!raw) throw new Error('Add your date of birth.');
  let year: number, month: number, day: number;
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (match) {
    year = Number(match[1]); month = Number(match[2]); day = Number(match[3]);
  } else {
    match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
    if (!match) throw new Error('Enter a valid date of birth.');
    day = Number(match[1]); month = Number(match[2]); year = Number(match[3]);
  }
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (year < 1900 || candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) {
    throw new Error('Enter a valid date of birth.');
  }
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (candidate.getTime() > today) throw new Error('Date of birth cannot be in the future.');
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

export function calculateCalendarAge(isoDateOfBirth: string, now = new Date()): number {
  const [year, month, day] = isoDateOfBirth.split('-').map(Number);
  let age = now.getUTCFullYear() - year;
  if (now.getUTCMonth() + 1 < month || (now.getUTCMonth() + 1 === month && now.getUTCDate() < day)) age--;
  return age;
}

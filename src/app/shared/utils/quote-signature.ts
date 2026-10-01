/**
 * Deterministic quote signature over exactly the inputs the server's price is a function of.
 *
 * One authoritative dedupe key, shared by the customer page guard and the pricing service's
 * in-flight/recent cache. Previously the service key omitted the pickup/dropoff coordinates, so
 * two different journeys with the same distance and duration could be treated as one quote,
 * and repeated form changes produced a fresh POST each time.
 *
 * If none of these inputs changed, the authoritative quote cannot change.
 */
export const QUOTE_COORDINATE_PRECISION = 5;
export const QUOTE_MEASURE_PRECISION = 2;

export interface QuoteSignatureInput {
  lat?: number | null;
  lng?: number | null;
  dropoffLat?: number | null;
  dropoffLng?: number | null;
  serviceSlug?: string | null;
  vehicleClass?: string | null;
  passengerCount?: number | null;
  distanceKm?: number | null;
  durationMinutes?: number | null;
  packageSize?: string | null;
  itemCount?: number | null;
  errandMode?: string | null;
  budget?: number | null;
  countryCode?: string | null;
  currencyCode?: string | null;
  moveDetails?: {
    size?: unknown;
    helperCount?: unknown;
    stairsInvolved?: unknown;
    packingAssistance?: unknown;
    fragileItems?: unknown;
  } | null;
}

const round = (value: unknown, precision: number): number | null => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const factor = 10 ** precision;
  return Math.round(numeric * factor) / factor;
};

const text = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const normalised = String(value).trim();
  return normalised ? normalised : null;
};

const bool = (value: unknown): boolean => value === true;

export function buildQuoteSignature(input: QuoteSignatureInput | null | undefined): string {
  const move = input?.moveDetails || null;
  return JSON.stringify([
    round(input?.lat, QUOTE_COORDINATE_PRECISION),
    round(input?.lng, QUOTE_COORDINATE_PRECISION),
    round(input?.dropoffLat, QUOTE_COORDINATE_PRECISION),
    round(input?.dropoffLng, QUOTE_COORDINATE_PRECISION),
    text(input?.serviceSlug),
    text(input?.vehicleClass),
    round(input?.passengerCount, 0),
    round(input?.distanceKm, QUOTE_MEASURE_PRECISION),
    round(input?.durationMinutes, QUOTE_MEASURE_PRECISION),
    text(input?.packageSize),
    round(input?.itemCount, 0),
    text(input?.errandMode),
    round(input?.budget, QUOTE_MEASURE_PRECISION),
    text(input?.countryCode),
    text(input?.currencyCode),
    text(move?.size),
    round(move?.helperCount, 0),
    bool(move?.stairsInvolved),
    bool(move?.packingAssistance),
    bool(move?.fragileItems)
  ]);
}

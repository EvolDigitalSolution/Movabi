/**
 * Canonical, USER-FACING service names.
 *
 * Reuses the existing Movabi product terminology already shown on the Activity
 * and Home lists (Ride / Shop / Deliver / Move) so the same service is never
 * described two different ways.
 *
 * Internal `ServiceTypeSlug` values are NEVER changed - this is DISPLAY ONLY:
 *   ride | errand | delivery | van-moving
 *
 * An unknown/absent slug returns the neutral "Request", never a raw database
 * value and never an invented service name.
 */
const SERVICE_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  ride: 'Ride',
  errand: 'Shop',
  delivery: 'Deliver',
  'van-moving': 'Move'
};

export function serviceDisplayName(slug: string | null | undefined): string {
  const key = String(slug ?? '').trim().toLowerCase().replace(/_/g, '-');
  return SERVICE_DISPLAY_NAMES[key] ?? 'Request';
}

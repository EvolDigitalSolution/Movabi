import { expect, test, Page } from '@playwright/test';
import { loginAs, lastBookingCreateBody, resetBookingCreateBody, setQuoteNoShowEnabled, setWalletBalance } from './fixtures/movabi-mocks';

/**
 * The no-show terms are SERVER-ISSUED: `setQuoteNoShowEnabled` only controls what the
 * mocked `/api/pricing/global-ai/quote` response returns as `noShow`. There is no
 * URL query param or localStorage feature override anywhere in this flow.
 */
async function startRideRequest(page: Page, noShow: boolean) {
  setQuoteNoShowEnabled(noShow);
  setWalletBalance(null); // £42.50 available — funds the £3.50 quoted ride
  resetBookingCreateBody(); // assert on THIS test's submission only

  await loginAs(page, 'customer');
  await page.getByRole('button', { name: /book a ride/i }).click();
  await expect(page).toHaveURL(/\/customer\/request/);
  await expect(page.getByText(/Ride Request/i).first()).toBeVisible();

  const manual = page.getByRole('button', { name: /continue with manual address/i });
  if (await manual.isVisible().catch(() => false)) {
    await manual.click();
  }

  await page.getByRole('textbox', { name: /pickup address/i }).fill('Back Skipton Street, Bolton');
  await page.getByRole('button', { name: /Back Skipton Street/i }).first().click();
  await page.getByRole('textbox', { name: /where should we deliver/i }).fill('Tonge Moor Primary Academy, Bolton');
  await page.getByRole('button', { name: /Tonge Moor Primary Academy/i }).first().click();

  await expect(page.getByRole('textbox', { name: /pickup address/i })).toHaveValue(/Back Skipton Street/i);
  await expect(page.getByRole('textbox', { name: /where should we deliver/i })).toHaveValue(/Tonge Moor Primary Academy/i);

  // Exercise wallet checkout explicitly; card is the current default.
  await page.getByRole('radio', { name: 'Use existing wallet credit', exact: true }).check();
}

/** The client posts `{ booking: insertPayload }`; acknowledgement lives in `metadata`. */
function submittedMetadata(): Record<string, unknown> {
  const booking = (lastBookingCreateBody?.['booking'] || {}) as Record<string, unknown>;
  return (booking['metadata'] || {}) as Record<string, unknown>;
}

test.describe('customer no-show booking disclosure', () => {
  test('disabled: ordinary booking still succeeds', async ({ page }) => {
    await startRideRequest(page, false);

    // No server terms => no disclosure and no acknowledgement requirement.
    await expect(page.getByTestId('no-show-disclosure')).toHaveCount(0);

    const walletButton = page.getByRole('button', { name: /request with wallet/i });
    await expect(walletButton).toBeEnabled({ timeout: 20_000 });
    await walletButton.click();

    await expect.poll(() => lastBookingCreateBody, { timeout: 15_000 }).not.toBeNull();
    const metadata = submittedMetadata();
    expect(metadata['no_show_acknowledged']).toBe(false);
    expect(metadata['no_show_policy_version']).toBeNull();

    // Booking success state.
    await expect(page).toHaveURL(/\/customer\/tracking\/booking-test/, { timeout: 15_000 });
  });

  test('enabled £3.50 ride discloses the £1.75 exact fee', async ({ page }) => {
    await startRideRequest(page, true);

    const disclosure = page.getByTestId('no-show-disclosure');
    await expect(disclosure).toBeVisible({ timeout: 20_000 });
    await expect(disclosure).toContainText('By booking, you agree to the cancellation and no-show policy.');
    await disclosure.locator('summary').click();
    await expect(disclosure.locator('details')).toHaveAttribute('open', '');
    await expect(disclosure.locator('details p')).toBeVisible();
    await expect(disclosure.locator('details p')).toContainText('5 minutes');
    await expect(disclosure.locator('details p')).toContainText('£1.75');
    await expect(disclosure.locator('details p')).toContainText('not charged a separate waiting fee');

    // Ionic scrolls inside ion-content, so capture the disclosure block itself.
    await disclosure.scrollIntoViewIfNeeded();
    await disclosure.screenshot({ path: 'test-results-no-show/no-show-disclosure.png' });
  });

  test('policy can be opened and closed without blocking a valid funded booking', async ({ page }) => {
    await startRideRequest(page, true);
    const disclosure = page.getByTestId('no-show-disclosure');
    await expect(disclosure).toBeVisible({ timeout: 20_000 });
    const walletButton = page.getByRole('button', { name: /request with wallet/i });
    await expect(walletButton).toBeEnabled();
    await expect(page.getByRole('checkbox', { name: /acknowledge the no-show policy/i })).toHaveCount(0);
    await disclosure.locator('summary').click();
    await expect(disclosure.locator('details p')).toBeVisible();
    await expect(walletButton).toBeEnabled();
    await disclosure.locator('summary').click();
    await expect(disclosure.locator('details p')).not.toBeVisible();
    await expect(walletButton).toBeEnabled();
    expect(lastBookingCreateBody).toBeNull();
  });

  test('booking with disclosed server terms persists the policy version and succeeds', async ({ page }) => {
    await startRideRequest(page, true);

    await expect(page.getByTestId('no-show-disclosure')).toBeVisible({ timeout: 20_000 });
    const walletButton = page.getByRole('button', { name: /request with wallet/i });
    // The current flow accepts the disclosed policy when the customer books.
    await expect(walletButton).toBeEnabled({ timeout: 20_000 });
    await walletButton.click();

    // The acknowledgement is carried through the real booking contract.
    await expect.poll(() => lastBookingCreateBody, { timeout: 15_000 }).not.toBeNull();
    const metadata = submittedMetadata();
    expect(metadata['no_show_acknowledged']).toBe(true);
    expect(metadata['no_show_policy_version']).toBe('ride-no-show-v1');

    const booking = (lastBookingCreateBody?.['booking'] || {}) as Record<string, unknown>;
    expect(Number(booking['total_price'])).toBeCloseTo(3.5, 2);

    // Booking success state.
    await expect(page).toHaveURL(/\/customer\/tracking\/booking-test/, { timeout: 15_000 });
  });
});

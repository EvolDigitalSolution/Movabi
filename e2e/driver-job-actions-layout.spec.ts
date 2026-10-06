import { expect, test } from '@playwright/test';
import { loginAs, serviceTypes, setNoShowJob } from './fixtures/movabi-mocks';

test.use({ viewport: { width: 390, height: 844 } });

/** Reach the driver's job-details screen for an accepted request. */
async function openDriverJob(page: import('@playwright/test').Page) {
  await loginAs(page, 'driver');
  const accept = page.getByRole('button', { name: /accept/i }).first();
  await expect(accept).toBeVisible();
  await accept.click();

  const continueJob = page.getByRole('button', { name: /continue job/i });
  await expect(continueJob).toBeVisible({ timeout: 15_000 });
  await continueJob.click();
  await expect(page).toHaveURL(/\/driver\/job-details/);
}

test.describe('driver job action area placement', () => {
  test('ride: action area sits below the status summary, above the details, and is sticky/opaque', async ({ page }) => {
    await openDriverJob(page);

    const panel = page.getByTestId('job-action-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });

    // Placed ABOVE the first detailed card.
    const panelBox = (await panel.boundingBox())!;
    const detailsBox = (await page.locator('app-card').first().boundingBox())!;
    expect(panelBox.y).toBeLessThan(detailsBox.y);

    // Sticky below the app header, with an OPAQUE background.
    const styles = await panel.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { position: cs.position, top: cs.top, zIndex: cs.zIndex, bg: cs.backgroundColor };
    });
    expect(styles.position).toBe('sticky');
    expect(styles.top).toBe('0px');
    expect(Number(styles.zIndex)).toBeGreaterThan(0);
    // Opaque: not transparent and no fractional alpha (rgb/oklch both accepted;
    // Tailwind v4 emits oklch).
    expect(styles.bg).not.toBe('transparent');
    expect(styles.bg).not.toMatch(/rgba\([^)]*,\s*0?\.\d+/);
    expect(styles.bg).not.toMatch(/\/\s*0?\.\d+\s*\)/);

    // Usable at 390px: no horizontal overflow anywhere on the page.
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      win: window.innerWidth
    }));
    expect(overflow.doc).toBeLessThanOrEqual(overflow.win);
    expect(panelBox.width).toBeLessThanOrEqual(390);

    // The primary action is reachable by keyboard.
    const primary = panel.getByRole('button').first();
    await primary.focus();
    await expect(primary).toBeFocused();

    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results-no-show/driver-job-actions-sticky.png' });
  });

  test('ride: the panel can scroll when it exceeds the available height', async ({ page }) => {
    await openDriverJob(page);

    const panel = page.getByTestId('job-action-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });

    const scrollable = await panel.evaluate((el) => getComputedStyle(el).overflowY);
    expect(['auto', 'scroll']).toContain(scrollable);

    // The panel is capped so it can never exceed the viewport.
    const capped = await panel.evaluate((el) => parseFloat(getComputedStyle(el).maxHeight));
    expect(Number.isFinite(capped)).toBe(true);
  });

  test('errand: the service-specific action renders in the moved panel without overflow', async ({ page }) => {
    const errandService = serviceTypes.find((s) => s.slug === 'errand')!;
    setNoShowJob({ service_slug: 'errand', service_type: errandService, service_type_id: errandService.id });

    await openDriverJob(page);

    const panel = page.getByTestId('job-action-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });

    // The errand flow keeps its own current action (no ride-only arrival control here).
    const panelBox = (await panel.boundingBox())!;
    const detailsBox = (await page.locator('app-card').first().boundingBox())!;
    expect(panelBox.y).toBeLessThan(detailsBox.y);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(overflow).toBeLessThanOrEqual(390);

    setNoShowJob(null);
  });
});

import {test,expect,type Page} from '@playwright/test';
import {installMovabiMocks,ids} from './fixtures/movabi-mocks';

// Driver earnings: an errand earning's expanded details must show the
// non-commissionable shopping reimbursement (errand_purchase_payments)
// separately from commissionable fare earnings (driver_earnings), even though
// both travelled in the same Stripe transfer. Sourced from
// GET /api/booking/:jobId/purchase-ledger, fetched lazily on expand.
const jobId='30000000-0000-4000-8000-0000000000aa';
const earning={
  id:'earn-errand-1',driver_id:ids.driver,job_id:jobId,
  amount:8.5,gross_amount:10,platform_fee:1,commission_rate_used:15,
  status:'paid',currency_code:'GBP',stripe_transfer_id:'tr_sim_1',
  settlement_purpose:'job_earnings',created_at:new Date().toISOString()
};
const ledger={
  purchases:[{id:'pp-1',purchase_method:'driver_personal',payer:'driver',kind:'manual',
    amount_minor:2000,currency:'GBP',status:'reimbursed',
    reimbursement_transfer_id:'tr_sim_1',provider_reference:'manual-spend',
    created_at:new Date().toISOString()}],
  earnings:[earning],
  payout:{status:'paid',amount_minor:2850,currency:'GBP',transfer_id:'tr_sim_1',
    reimbursement_minor:2000,purchase_method:'driver_personal'}
};

async function setup(page:Page,opts:{ledger:{status:number;json:unknown}}){
  await installMovabiMocks(page,'driver');
  await page.route('**/rest/v1/driver_earnings*',route=>route.fulfill({json:[earning]}));
  await page.route(`**/api/booking/${jobId}/purchase-ledger`,route=>route.fulfill({status:opts.ledger.status,json:opts.ledger.json}));
  await page.route('**/api/booking/offer-metrics*',route=>route.fulfill({json:{accepted:0,declined:0,acceptanceRate:0,declineRate:0,windowDays:30}}));
  await page.route('**/api/market-safety/**',route=>route.fulfill({json:{driverId:ids.driver,tenantId:ids.tenant,country:'GB',currency:'GBP',payoutAvailable:true,balance:{currency:'GBP',consistent:true,availableMinor:'0',heldMinor:'0'}}}));
  await page.goto('/auth/login');
  await page.getByLabel(/email address/i).fill('driver@movabi.test');
  await page.getByRole('textbox',{name:/^password$/i}).fill('Password123!');
  await page.getByRole('button',{name:/sign in/i}).click();
  await expect(page).toHaveURL(/\/driver/);
  await page.goto('/driver/earnings');
  await expect(page.locator('.earning-record')).toHaveCount(1);
}

test.describe('Driver earnings — errand purchase ledger',()=>{
  test('expanded earning shows the shopping reimbursement separately from earnings',async({page})=>{
    await setup(page,{ledger:{status:200,json:ledger}});
    await page.locator('.earning-summary').click();
    const details=page.locator('.earning-details');
    await expect(details.getByText('Shopping reimbursement')).toBeVisible();
    await expect(details.getByText(/£20\.00/)).toBeVisible();
    await expect(details.getByText(/reimbursed/)).toBeVisible();
    await expect(details.getByText(/Non-commissionable/)).toBeVisible();
    // Commissionable earnings rows remain untouched.
    await expect(details.getByText('Net payout')).toBeVisible();
    await expect(details.getByText('Gross earnings')).toBeVisible();
  });

  test('a denied/missing ledger degrades gracefully — earnings still readable',async({page})=>{
    await setup(page,{ledger:{status:403,json:{code:'JOB_ACCESS_DENIED'}}});
    await page.locator('.earning-summary').click();
    const details=page.locator('.earning-details');
    await expect(details.getByText('Net payout')).toBeVisible();
    await expect(details.getByText('Shopping reimbursement')).toHaveCount(0);
  });
});

import {test,expect} from '@playwright/test';
import {installMovabiMocks} from './fixtures/movabi-mocks';
test('booking callback status cannot confirm payment; authenticated server verification can',async({page})=>{
 await installMovabiMocks(page,'customer');
 await page.route('**/api/market-safety/**',route=>route.fulfill({status:503,json:{code:'SYNTHETIC_UNAVAILABLE'}}));
 let verified=false;
 await page.route('**/api/payment/flutterwave-booking-split/verify',route=>route.fulfill(verified?
  {json:{paymentVerified:true,driverSettlement:'pending'}}:{status:409,json:{error:'Not confirmed'}}));
 await page.goto('/auth/login');await page.getByLabel(/email address/i).fill('customer@movabi.test');
 await page.getByRole('textbox',{name:/^password$/i}).fill('Password123!');await page.getByRole('button',{name:/sign in/i}).click();
 await expect(page).toHaveURL(/\/customer/);
 await page.goto('/booking-payment-return?tx_ref=vaydu-split-11111111-1111-4111-8111-111111111111&status=successful&transaction_id=77');
 const panel=page.getByRole('region',{name:'Booking payment status'});
 await expect(panel).toContainText('Payment has not been verified');await panel.getByRole('button',{name:'Check payment status'}).click();
 await expect(panel).toContainText('Payment is not confirmed');verified=true;await panel.getByRole('button',{name:'Check payment status'}).click();
 await expect(panel).toContainText('Payment verified. Driver settlement is still pending confirmation.');
 await expect(panel.getByRole('link',{name:'Return to booking'})).toHaveAttribute('href','/customer/tracking/11111111-1111-4111-8111-111111111111');
});

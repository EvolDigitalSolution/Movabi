import {test,expect} from '@playwright/test';
import {installMovabiMocks} from './fixtures/movabi-mocks';
for(const screen of ['settings','onboarding']){
for(const recovery of [false,true]){
test('Bank payment account on '+screen+' resolves, confirms and persists'+(recovery?' after timeout reconciliation':''),async({page})=>{
 await installMovabiMocks(page,'driver');
 await page.route('**/api/market-safety/**',route=>route.fulfill({status:503,json:{code:'SYNTHETIC_UNAVAILABLE'}}));
 let completed=false;let saved=0;
 await page.route('**/api/driver-payment-account/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('/status'))return route.fulfill({json:{provider:'flutterwave',state:completed?'completed':'not_started',available:true,last4:completed?'6789':null}});
  if(path.endsWith('/banks'))return route.fulfill({json:{banks:[{code:'044',name:'Synthetic Bank'}]}});
  if(path.endsWith('/reconcile'))return route.fulfill({json:{state:'completed',last4:'6789',reconcileOnly:false}});
  const body=route.request().postDataJSON();
  if(path.endsWith('/resolve')){expect(body.accountNumber).toBe('0123456789');return route.fulfill({json:{accountName:'Synthetic Driver'}});}
  expect(body.confirmed).toBe(true);expect(body.accountName).toBe('Synthetic Driver');completed=true;saved++;
  if(recovery)return route.fulfill({status:409,json:{error:'Setup outcome requires reconciliation'}});
  return route.fulfill({json:{state:'completed',last4:'6789'}});
 });
 await page.goto('/auth/login');await page.getByLabel(/email address/i).fill('driver@movabi.test');
 await page.getByRole('textbox',{name:/^password$/i}).fill('Password123!');await page.getByRole('button',{name:/sign in/i}).click();await expect(page).toHaveURL(/\/driver/);
 await page.goto('/driver/'+screen);
 const panel=page.getByRole('region',{name:'Payment account'});
 await panel.getByRole('button',{name:'Set up payment account',exact:true}).click();
 await panel.getByRole('combobox',{name:'Bank',exact:true}).selectOption('044');await panel.getByRole('textbox',{name:'Account number',exact:true}).fill('0123456789');
 await panel.getByRole('button',{name:'Check account',exact:true}).click();await expect(panel).toContainText('Synthetic Driver');
 await expect(panel.getByRole('button',{name:'Confirm payment account',exact:true})).toBeDisabled();
 await panel.getByRole('checkbox').check();await panel.getByRole('button',{name:'Confirm payment account',exact:true}).click();
 if(recovery){await expect(panel.getByRole('button',{name:'Check setup status',exact:true})).toBeVisible();await expect(panel.getByRole('button',{name:'Confirm payment account',exact:true})).toHaveCount(0);await panel.getByRole('button',{name:'Check setup status',exact:true}).click();}
 await expect(panel).toContainText('ending 6789');await expect(panel).not.toContainText('0123456789');
 await page.reload();await expect(panel).toContainText('ending 6789');expect(saved).toBe(1);
});

}

}

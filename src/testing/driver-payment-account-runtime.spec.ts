import {describe,it,expect,vi,afterEach} from 'vitest';
vi.mock('../../server/services/supabase.service',()=>({supabaseAdmin:{}}));
vi.mock('../../server/services/stripe.service',()=>{throw Error('Flutterwave runtime must not initialize Stripe.');});
import {createDriverPaymentAccountSandbox} from '../../server/driver-payment-account-sandbox';
function configure(){
 for(const [key,value] of Object.entries({NODE_ENV:'test',VAYDU_DEPLOYMENT_ENV:'develop',VAYDU_DRIVER_PAYOUT_SANDBOX:'true',
  SUPABASE_URL:'http://movabi-develop-kong:8000',FLUTTERWAVE_TEST_SECRET_KEY:'FLWSECK_TEST-synthetic',
  DRIVER_PAYOUT_FINGERPRINT_KEY:'synthetic-hmac-key-at-least-32-characters',FLUTTERWAVE_PAYOUT_MERCHANT_REF:'synthetic-merchant',
  FLUTTERWAVE_PAYOUT_CALLBACK_URL:'https://movabi-develop.apps.evolsolution.com/api/driver-payment-account/webhook',
  VAYDU_DRIVER_PAYOUT_CALLBACK_APPROVED:'true',FLUTTERWAVE_PAYOUT_WEBHOOK_SECRET:'synthetic-independent-webhook-32-characters',STRIPE_SECRET_KEY:''}))vi.stubEnv(key,value);
 vi.stubEnv('VAYDU_DRIVER_SUBACCOUNT_SANDBOX','false');vi.stubEnv('FLUTTERWAVE_SECRET_KEY','');vi.stubEnv('FLUTTERWAVE_LIVE_SECRET_KEY','');
}
describe('isolated payment-account runtime',()=>{
 it('starts without a Stripe credential or Stripe initialization',()=>{configure();expect(createDriverPaymentAccountSandbox()).toBeDefined();});
 it('refuses a production Supabase connection',()=>{configure();vi.stubEnv('SUPABASE_URL','https://production.example');expect(()=>createDriverPaymentAccountSandbox()).toThrow('develop database');});
 it('refuses live Flutterwave credentials before any provider call',()=>{configure();vi.stubEnv('FLUTTERWAVE_TEST_SECRET_KEY','FLWSECK-live');expect(()=>createDriverPaymentAccountSandbox()).toThrow();});
 it('refuses a live Stripe credential even though Stripe is not used',()=>{configure();vi.stubEnv('STRIPE_SECRET_KEY','sk_live_synthetic');expect(()=>createDriverPaymentAccountSandbox()).toThrow('Live credentials');});
 it('collection setup starts without enabling or configuring transfer payouts',()=>{configure();vi.stubEnv('VAYDU_DRIVER_SUBACCOUNT_SANDBOX','true');vi.stubEnv('VAYDU_DRIVER_PAYOUT_SANDBOX','false');vi.stubEnv('FLUTTERWAVE_PAYOUT_MERCHANT_REF','');vi.stubEnv('FLUTTERWAVE_PAYOUT_WEBHOOK_SECRET','');vi.stubEnv('FLUTTERWAVE_COLLECTION_MERCHANT_REF','test-merchant');expect(createDriverPaymentAccountSandbox()).toBeDefined();});
 it('collection setup rejects a live key even when a valid test key is also present',()=>{configure();vi.stubEnv('VAYDU_DRIVER_SUBACCOUNT_SANDBOX','true');vi.stubEnv('FLUTTERWAVE_COLLECTION_MERCHANT_REF','test-merchant');vi.stubEnv('FLUTTERWAVE_LIVE_SECRET_KEY','FLWSECK-live');expect(()=>createDriverPaymentAccountSandbox()).toThrow('Live Flutterwave');});
});
afterEach(()=>vi.unstubAllEnvs());

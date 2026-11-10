import {describe,it} from 'vitest';
import assert from 'node:assert/strict';
import {PROVIDER_CURRENCY_OPTIONS,STRIPE_REQUESTED_CURRENCIES,STRIPE_AMEX_EXCLUDED_CURRENCIES,KORA_REQUESTED_FIAT_CURRENCIES,KORA_REQUESTED_STABLECOINS,providerCurrencyOption} from '../../server/services/payments/provider-currency-options';
import {stripeApiAmount,stripeApiAmountFromLedger,stripeAmountRule} from '../../server/services/payments/stripe-currency-amounts';
import {paymentPolicies} from '../../server/services/payments/market-payment-registry';
describe('requested provider currency configuration',()=>{
 it('retains all 10 requested Kora fiat currencies',()=>assert.deepEqual([...KORA_REQUESTED_FIAT_CURRENCIES],['NGN','KES','GHS','ZAR','XOF','XAF','EGP','TZS','USD','GBP']));
 it('retains the complete Stripe list without duplicate currency codes',()=>{assert.equal(STRIPE_REQUESTED_CURRENCIES.length,134);assert.equal(new Set(STRIPE_REQUESTED_CURRENCIES).size,134);for(const code of STRIPE_REQUESTED_CURRENCIES)assert.match(code,/^[A-Z]{3}$/);});
 it('keeps USDT/USDC in a network-specific wallet product',()=>{assert.deepEqual([...KORA_REQUESTED_STABLECOINS],['USDT','USDC']);for(const code of KORA_REQUESTED_STABLECOINS){const option=providerCurrencyOption('kora',code)!;assert.equal(option.product,'stablecoin_wallet');assert.equal(option.networkRequired,true);}});
 it('does not activate countries, merchants or adapters through a currency list',()=>{for(const option of PROVIDER_CURRENCY_OPTIONS){assert.equal(option.enabled,false);assert.equal(option.merchantApprovalRequired,true);assert.equal(option.installedAdapterRequired,true);assert.equal(option.countryRequired,true);assert.ok(Object.isFrozen(option));}});
 it('retains the asterisk meaning as American Express exclusion',()=>{for(const code of STRIPE_AMEX_EXCLUDED_CURRENCIES)assert.equal(providerCurrencyOption('stripe',code)?.amexSupported,false);assert.equal(providerCurrencyOption('stripe','USD')?.amexSupported,true);});
 it('does not turn a shared currency into a country',()=>{assert.ok(!('country' in providerCurrencyOption('kora','XOF')!));assert.ok(!('country' in providerCurrencyOption('stripe','USD')!));});
 it('keeps existing Kora readiness checks intact',()=>assert.throws(()=>paymentPolicies(JSON.stringify([{provider:'kora',merchantAccountRef:'account',country:'NG',currency:'NGN',enabled:true,merchantApproved:true,adapterReady:true,payoutApproved:false,methods:['card'],capabilities:['retrieve']}]))));
});
describe('Stripe provider amount encoding',()=>{
 for(const currency of ['USD','GBP','NGN','KES','EGP','ZAR'])it('encodes '+currency+' without floating point arithmetic',()=>assert.equal(stripeApiAmount('12.34',currency),1234));
 for(const currency of ['BIF','CLP','DJF','GNF','JPY','KMF','KRW','MGA','PYG','RWF','VND','VUV','XAF','XOF','XPF'])it('encodes whole-unit '+currency,()=>{assert.equal(stripeApiAmount('500',currency),500);assert.equal(stripeApiAmount('500.00',currency),500);assert.throws(()=>stripeApiAmount('500.01',currency));});
 for(const currency of ['ISK','UGX'])it('uses whole amounts with two API digits for '+currency,()=>{assert.equal(stripeApiAmount('5',currency),500);assert.equal(stripeApiAmount('5.00',currency),500);assert.throws(()=>stripeApiAmount('5.01',currency));assert.equal(stripeApiAmountFromLedger(5,currency,0),500);});
 for(const currency of ['HUF','TWD'])it('distinguishes charges from manual bank payouts for '+currency,()=>{assert.equal(stripeApiAmount('10.45',currency,'charge'),1045);assert.equal(stripeApiAmount('10',currency,'payout'),1000);assert.throws(()=>stripeApiAmount('10.45',currency,'payout'));});
 it('rejects an unrepresentable ledger amount rather than rounding',()=>{assert.equal(stripeApiAmountFromLedger(50000,'MGA',2),500);assert.throws(()=>stripeApiAmountFromLedger(50025,'MGA',2));});
 for(const value of ['1e3','NaN','Infinity','-1',' 1','01','1.001'])it('rejects invalid exact amount '+value,()=>assert.throws(()=>stripeApiAmount(value,'USD')));
 it('rejects unsafe API integers',()=>assert.throws(()=>stripeApiAmount('9007199254740991','USD')));
 it('rejects unknown and stablecoin codes in the fiat card encoder',()=>{for(const code of ['USDT','USDC','XYZ','usd'])assert.throws(()=>stripeAmountRule(code));});
 it('does not guess stablecoin precision, network or fiat exchange rate',()=>{const option=providerCurrencyOption('kora','USDT')!;assert.ok(!('apiExponent' in option));assert.ok(!('exchangeRate' in option));});
});

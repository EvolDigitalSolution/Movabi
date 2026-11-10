import {describe,it,expect} from 'vitest';
import {quoteWalletTopup} from '../../server/services/payments/wallet-fee-policy';
import {assertApprovedDriverFee,DRIVER_SANDBOX_FEE_VERSION} from '../../server/services/payments/driver-topup-approved-policy';
describe('approved shared card fee',()=>{
 it.each([0,2,3])('quotes major units 10000 + 500 = 10500 at exponent %s',exponent=>{
  for(const provider of ['stripe','flutterwave','kora']){
   const q=quoteWalletTopup(10000*10**exponent,{version:DRIVER_SANDBOX_FEE_VERSION,provider,country:'ZZ',currency:'TST',method:'card',exponent,feeBasis:'wallet',feeBasisPoints:500,feeFixedMinor:0,rounding:'half_up'});
   expect(q.providerFeeMinor).toBe(500*10**exponent);expect(q.totalChargeMinor).toBe(10500*10**exponent);
  }
 });
 it('rounds half-up once in minor units and fails on overflow',()=>{
  const p={version:DRIVER_SANDBOX_FEE_VERSION,provider:'stripe',country:'ZZ',currency:'TST',method:'card',exponent:0,feeBasis:'wallet' as const,feeBasisPoints:500,feeFixedMinor:0,rounding:'half_up' as const};
  expect(quoteWalletTopup(9,p).providerFeeMinor).toBe(0);expect(quoteWalletTopup(10,p).providerFeeMinor).toBe(1);
  expect(()=>quoteWalletTopup(Number.MAX_SAFE_INTEGER,p)).toThrow();
 });
 it('requires the exact approved version/terms',()=>{
  const p={version:DRIVER_SANDBOX_FEE_VERSION,fee_basis:'wallet',fee_basis_points:500,fee_fixed_minor:0,fee_cap_minor:null,rounding:'half_up'};
  expect(()=>assertApprovedDriverFee(p)).not.toThrow();
  for(const changed of [{version:'other'},{fee_basis:'total'},{fee_basis_points:501},{fee_fixed_minor:1},{fee_cap_minor:100},{rounding:'ceil'}])expect(()=>assertApprovedDriverFee({...p,...changed})).toThrow();
 });
});

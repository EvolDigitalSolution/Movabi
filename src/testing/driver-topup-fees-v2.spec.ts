import { describe,it,expect } from 'vitest';
import {quoteWalletTopup,type WalletFeePolicy} from '../../server/services/payments/wallet-fee-policy';
import {driverTopupMinor,driverTopupMoney} from '../app/shared/utils/driver-topup-money';
const policy:WalletFeePolicy={version:'synthetic-v2',provider:'flutterwave',country:'NG',currency:'NGN',method:'card',exponent:2,feeBasisPoints:150,feeFixedMinor:100,feeBasis:'total',rounding:'ceil'};
describe('exact fee schedules and driver money entry',()=>{
 it('grosses up total plus fixed to exactly cover the approved fee',()=>{
  const q=quoteWalletTopup(10000,policy); expect(q.totalChargeMinor).toBe(10254); expect(q.providerFeeMinor).toBe(254);
 });
 it('applies cap and explicit zero fee',()=>{
  expect(quoteWalletTopup(10000,{...policy,feeCapMinor:200}).totalChargeMinor).toBe(10200);
  expect(quoteWalletTopup(10000,{...policy,feeBasisPoints:0,feeFixedMinor:0}).totalChargeMinor).toBe(10000);
 });
 it('keeps multiplication exact near the safe integer limit',()=>{
  const q=quoteWalletTopup(8000000000000001,{...policy,feeBasis:'wallet',feeFixedMinor:0});
  expect(q.providerFeeMinor).toBe(120000000000001);
  expect(()=>quoteWalletTopup(Number.MAX_SAFE_INTEGER,policy)).toThrow();
 });
 it.each([0,2,3])('parses and formats exponent %s without floating point',exponent=>{
  const text=exponent?'12.'+'3'.repeat(exponent):'12';
  const minor=driverTopupMinor(text,exponent); expect(driverTopupMoney(minor,'TST',exponent)).toBe('TST '+text);
  expect(()=>driverTopupMinor(text+'.1',exponent)).toThrow();
 });
 it('rejects fractional minors, scientific notation and overflow',()=>{
  for(const text of ['1.234','1e3','9007199254740992','-1','']) expect(()=>driverTopupMinor(text,2)).toThrow();
  expect(()=>quoteWalletTopup(100,{...policy,exponent:1.5})).toThrow();
 });
});

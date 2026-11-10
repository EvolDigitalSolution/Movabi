import { describe, expect, it } from 'vitest';
import { computeMarketAdjustment } from '../../server/services/market-pricing.service';
import { PaymentMarginService } from '../../server/services/payment-margin.service';
import { FareSplitService } from '../../server/services/fare-split.service';
import type { MarketPricingStrategy } from '../../server/types/market-pricing.types';
const strategy: MarketPricingStrategy = {
 id:'inclusive-target', countryCode:'GB', marketCity:null, zoneId:null,
 serviceType:'ride', vehicleClass:null, strategy:'beat_market', targetDifferencePercent:7,
 minimumDriverHourlyRate:null, minimumDriverPerKm:null, minimumDriverPayout:null,
 minimumPlatformMarginPercent:0, minimumPlatformRevenue:0,
 maximumCustomerDiscountPercent:50, maximumMarketAdjustmentPercent:50,
 currency:'GBP', enabled:true
};
function quote(overrides = {}) {
 return computeMarketAdjustment({baseServiceFare:10, distanceKm:2, durationMinutes:5,
 platformFeePercent:5, driverCommissionPercent:15, strategy,
 marketReferenceFare:10, lowestCompetitorFare:10, benchmarkCount:3,
 featureEnabled:true, shadowMode:false, driverProtectionEnabled:true,
 platformMarginProtectionEnabled:true, ...overrides});
}
describe('inclusive competitor comparison and fee policy',()=>{
 it('beats a ten pound inclusive competitor price by seven percent',()=>{
  const result=quote(); expect(result.customerTotal).toBeCloseTo(9.30,2);
  expect(result.driverCommissionAmount).toBeCloseTo(result.adjustedServiceFare*.15,2);
 });
 it('matches the inclusive benchmark without adding five percent twice',()=>{
  expect(quote({strategy:{...strategy,strategy:'match_market'}}).customerTotal).toBe(10);
 });
 it('preserves live quotes while the market feature is disabled',()=>{
  expect(quote({featureEnabled:false}).customerTotal).toBe(10.50);
 });
 it('protects driver payout when beating competitors would underfund it',()=>{
  const result=quote({strategy:{...strategy,minimumDriverPayout:9}});
  expect(result.driverPayout).toBeGreaterThanOrEqual(9);
 });
 it('deducts driver commission from fare, excluding customer fee',()=>{
  const split=FareSplitService.compute({baseServiceFare:10,platformFee:FareSplitService.percentageFee(5),driverCommissionPercent:15,currency:'GBP',isPro:false});
  expect(split.customerCharge).toBe(10.50); expect(split.driverEntitlement).toBe(8.50);
  expect(split.grossRevenue).toBe(2);
 });
 it('keeps a small fare sustainable without lowering driver earnings',()=>{
  const policy={version:'test',currency:'GBP',paymentPercent:3.25,paymentFixed:.2,operatingAllowance:.1,minimumContribution:.5};
  const protectedPrice=PaymentMarginService.protect(2.10,1.70,0,policy);
  expect(protectedPrice.passes).toBe(true); expect(protectedPrice.contribution).toBeGreaterThanOrEqual(.5);
  expect(protectedPrice.customerCharge).toBeGreaterThan(2.10);
 });
});

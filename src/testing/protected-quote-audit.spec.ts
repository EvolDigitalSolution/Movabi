import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function harness(fail = false) {
 const s = readFileSync('server/services/pricing.service.ts','utf8');
 const method = s.slice(s.indexOf('    static async resolvePrice('),s.indexOf('    private static async resolveUnprotectedPrice('));
 const updates: object[] = [];
 const c = { exports: {} as { P: { resolvePrice: (o: object) => Promise<unknown> } },
 PaymentMarginService: { policy:()=>({}),protect:()=>({customerCharge:3.79,adjustment:0.34,paymentCost:0.32,contribution:0.5}) },
 MarketplaceConfigService:{canonicalServiceSlug:(s:string)=>s}, FareSplitService:{POLICY_VERSION:'test'},process:{env:{}},
 supabaseAdmin:{from:()=>({update:(v:object)=>{updates.push(v);return {eq:()=>({select:()=>({single:async()=>fail?{data:null,error:{message:'failed'}}:{data:{quote_reference:'q1'},error:null}})})};}})} };
 const code = `class PricingService { ${method}
 static roundMoney(v:number){return Math.round(v*100)/100;}
 static validateFareReconciliation(){return true;}
 static async resolveUnprotectedPrice(){return {totalPrice:3.45,platformFee:0.16,driverPayout:2.8,commissionFee:0.49,currencyCode:'GBP',pricingPlanUsed:'starter',fareBreakdown:{}};}
 } exports.P=PricingService;`;
 vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,c);
 return {pricing:c.exports.P,updates};
}
describe('protected quote audit',()=>{
 it('persists the final fare and protected split used by booking verification',async()=>{
 const h=harness();await h.pricing.resolvePrice({quoteReference:'q1',serviceSlug:'ride'});
 expect(h.updates).toEqual([{returned_customer_fare:3.79,customer_total:3.79,platform_fee_amount:0.5,driver_commission_amount:0.49,driver_payout:2.8,platform_revenue:0.99}]);
 });
 it('rejects a quote when final audit persistence fails',async()=>{
 await expect(harness(true).pricing.resolvePrice({quoteReference:'q1'})).rejects.toThrow('Final protected quote could not be verified');
 });
});

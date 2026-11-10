import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function tracking(job:any,funding:any={item_budget:10,amount_reserved:10},details:any={estimated_budget:10}) {
 const source=fs.readFileSync('src/app/apps/mobile/features/customer/booking-tracking/booking-tracking.page.ts','utf8');
 const methods=source.slice(source.indexOf('    getErrandItemBudget():'),source.indexOf('    searchCountdownLabel():'));
 const ctx:any={exports:{}};
 vm.runInNewContext(ts.transpileModule('export class Tracking { '+methods+' }',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,ctx);
 const page=new ctx.exports.Tracking();page.booking=()=>job;page.errandFunding=()=>funding;page.details=()=>details;return page;
}
describe('customer negotiated tracking totals',()=>{
 it('shows GBP19 rather than the original GBP19.39 authorization',()=>{const p=tracking({agreed_fare:9,total_price:9.39,fare_breakdown:{totalAuthorisation:19.39}});expect(p.getErrandServiceFee()).toBe(9);expect(p.getErrandTotalReserved()).toBe(19);});
 it('does not reuse an older larger total reservation',()=>{expect(tracking({agreed_fare:9,total_price:25},{item_budget:10,amount_reserved:35}).getErrandTotalReserved()).toBe(19);});
 it('uses an approved increased budget',()=>{expect(tracking({agreed_fare:9,total_price:9.39},{item_budget:15,amount_reserved:15}).getErrandTotalReserved()).toBe(24);});
 it('does not count a pending budget request as approved',()=>{expect(tracking({agreed_fare:9},{item_budget:10,requested_over_budget_amount:20,over_budget_status:'requested'}).getErrandTotalReserved()).toBe(19);});
 it('retains the existing non-negotiated total calculation',()=>{const p=tracking({total_price:19.39},{item_budget:10,amount_reserved:19.39});expect(p.getErrandTotalReserved()).toBe(19.39);});
});

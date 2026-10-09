import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import * as ts from 'typescript';
const file='src/app/apps/mobile/features/customer/booking-tracking/booking-tracking.page.ts';
function page(response: any = {data:{completion_pin:'4321'},error:null}) {
 const source=fs.readFileSync(file,'utf8');
 const start=source.indexOf('    private async refreshCustomerCompletionPin(');
 const end=source.indexOf('    private paidByWallet()',start);
 const code=ts.transpileModule('class TestPage { '+source.slice(start,end)+' } exports.TestPage=TestPage;', {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const context:any={exports:{},console};vm.runInNewContext(code,context);const p:any=new context.exports.TestPage();
 let pin='';p.customerCompletionPin=Object.assign(()=>pin,{set:(v:string)=>{pin=v;}});p.completionPinBookingId=null;
 p.user={id:'customer'};p.auth={currentUser:()=>p.user};p.current={id:'job',customer_id:'customer',driver_id:'driver',status:'en_route_to_customer'};p.booking=()=>p.current;
 p.isTerminalTrackingStatus=(s:string)=>['completed','cancelled','no_driver_found','expired','failed'].includes(s);
 p.bookingMetadata=()=>({});p.normalizeCompletionPin=(v:any)=>String(v??'').replace(/\D/g,'').slice(0,8);
 p.calls=0;
 const query = {
   select: () => ({
     eq: () => ({ maybeSingle: async () => response })
   })
 };
 p.supabase = {
   client: {
     schema: (schema: string) => {
       expect(schema).toBe('public');
       return {
         from: (table: string) => {
           expect(table).toBe('job_completion_secrets');
           p.calls++;
           return query;
         }
       };
     }
   }
 };

 return p;
}
describe('customer completion PIN',()=>{
 it('loads the customer-only secret and displays it during handover',async()=>{const p=page();await p.refreshCustomerCompletionPin(p.current);expect(p.completionPinForCustomer()).toBe('4321');expect(p.showCompletionPinPanel()).toBe(true);});
 it('never retrieves or displays the PIN for the driver',async()=>{const p=page();p.user={id:'driver'};await p.refreshCustomerCompletionPin(p.current);expect(p.calls).toBe(0);expect(p.completionPinForCustomer()).toBe('');});
 it('clears the PIN when the booking ends',async()=>{const p=page();await p.refreshCustomerCompletionPin(p.current);p.current.status='completed';await p.refreshCustomerCompletionPin(p.current);expect(p.completionPinForCustomer()).toBe('');expect(p.showCompletionPinPanel()).toBe(false);});
 it('retries a failed lookup on the next refresh',async()=>{const p=page({data:null,error:{code:'PGRST205'}});await p.refreshCustomerCompletionPin(p.current);await p.refreshCustomerCompletionPin(p.current);expect(p.calls).toBe(2);});
 it('does not refetch a successfully loaded PIN every poll',async()=>{const p=page();await p.refreshCustomerCompletionPin(p.current);await p.refreshCustomerCompletionPin(p.current);expect(p.calls).toBe(1);});
});

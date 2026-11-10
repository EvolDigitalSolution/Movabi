import {describe,it,expect,vi} from 'vitest';
import express from 'express';
vi.mock('../../server/services/supabase.service',()=>({supabaseAdmin:{}}));
import {flutterwaveBookingSplitRouter} from '../../server/routes/flutterwave-booking-split.routes';
async function request(path:string,body:any,authenticated=true){
 const service:any={quote:vi.fn(async()=>({public:{totalMinor:10000,currency:'NGN'},plan:{subaccountId:'RS_PRIVATE',driverId:'private-driver'}})),
  checkout:vi.fn(async()=>({checkoutUrl:'https://checkout.flutterwave.com/synthetic'})),verify:vi.fn(async()=>({paymentVerified:true,driverSettlement:'pending'})),settlement:vi.fn(async()=>{throw Error('raw bank/provider details');})};
 const db:any={auth:{getUser:async()=>({data:{user:{id:'authenticated-customer',email:'owner@example.test'}}})}};
 const app=express();app.use(express.json());app.use(flutterwaveBookingSplitRouter(db,service));
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',()=>resolve()));
 try{const address=server.address() as any;const response=await fetch(`http://127.0.0.1:${address.port}${path}`,{method:'POST',headers:{'Content-Type':'application/json',...(authenticated?{Authorization:'Bearer valid'}:{})},body:JSON.stringify(body)});
  return {status:response.status,body:await response.text(),service};
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
describe('booking split endpoint owner and terms authority',()=>{
 it('requires authentication',async()=>expect((await request('/quote',{jobId:'job'},false)).status).toBe(401));
 it('uses the authenticated customer and returns only the public frozen quote',async()=>{const h=await request('/quote',{jobId:'job',customerId:'other',amount:1,driverId:'other'});expect(h.service.quote).toHaveBeenCalledWith('authenticated-customer','job');expect(h.body).not.toContain('RS_PRIVATE');expect(h.body).not.toContain('private-driver');});
 it('uses the owner email rather than submitted provider identity',async()=>{const h=await request('/checkout',{jobId:'job',email:'other@example.test',confirmedTotalMinor:10000});expect(h.service.checkout).toHaveBeenCalledWith('authenticated-customer','job','owner@example.test',10000);});
 it('query/body payment status and transaction IDs are not accepted as proof',async()=>{const h=await request('/verify',{jobId:'job',status:'successful',transactionId:'77',total:1});expect(h.service.verify).toHaveBeenCalledWith('authenticated-customer','job');expect(h.body).toContain('"driverSettlement":"pending"');});
 it('suppresses raw settlement diagnostics',async()=>{const h=await request('/settlement',{jobId:'job'});expect(h.status).toBe(409);expect(h.body).not.toContain('raw bank');});
});

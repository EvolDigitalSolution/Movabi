import {describe,it,expect} from 'vitest';
import http from 'node:http';
import {createDriverCardSandbox} from '../../server/driver-card-sandbox';
const config={NODE_ENV:'test',VAYDU_SANDBOX_DEPLOYMENT:'develop',VAYDU_SANDBOX_WEB_ORIGIN:'https://movabi-develop.apps.evolsolution.com'};
describe('isolated driver card sandbox process',()=>{
 it.each([{NODE_ENV:'production'},{VAYDU_SANDBOX_DEPLOYMENT:'production'},{VAYDU_SANDBOX_WEB_ORIGIN:'https://movabi.apps.evolsolution.com'},{SUPABASE_URL:'https://movabi-supabase.apps.evolsolution.com'},{STRIPE_SECRET_KEY:'sk_live_synthetic'},{FLUTTERWAVE_SECRET_KEY:'FLWSECK-live-synthetic'}])('rejects unsafe deployment configuration %j',override=>{
  expect(()=>createDriverCardSandbox({...config,...override})).toThrow();
 });
 it('exposes only sandbox health/routes and allows only approved web/native origins',async()=>{
  const server=http.createServer(createDriverCardSandbox(config));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+(server.address() as any).port;
  try{
   expect(await (await fetch(base+'/health')).json()).toEqual({sandbox:true,liveCredentialsAllowed:false});
   expect((await fetch(base+'/api/payment/create-payment-intent',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status).toBe(404);
   expect((await fetch(base+'/health',{headers:{origin:'https://movabi.apps.evolsolution.com'}})).status).toBe(403);
   const preflight=await fetch(base+'/api/payment/driver-topup/checkout',{method:'OPTIONS',headers:{origin:'https://localhost','access-control-request-method':'POST','access-control-request-headers':'Authorization,Content-Type'}});
   expect(preflight.status).toBe(204);expect(preflight.headers.get('access-control-allow-origin')).toBe('https://localhost');
  }finally{server.close();}
 });
});

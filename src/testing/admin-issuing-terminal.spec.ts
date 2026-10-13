import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const jobId='5cd0a089-6758-4f03-834e-5d3fb3073015',requestId='95eec483-6774-4fcb-bd87-9593bf83b2fb';
const mocks=vi.hoisted(()=>({balance:vi.fn(),card:vi.fn(),create:vi.fn(),capture:vi.fn(),approval:true}));
vi.mock('../../server/services/stripe.service',()=>({stripe:{balance:{retrieve:mocks.balance},issuing:{cards:{retrieve:mocks.card}},testHelpers:{issuing:{authorizations:{create:mocks.create,capture:mocks.capture}}}}}));
vi.mock('../../server/services/audit.service',()=>({AuditService:{log:vi.fn()}}));
vi.mock('../../server/services/supabase.service',()=>({supabaseAdmin:{from:(table:string)=>({select(){return this;},eq(){return this;},single:async()=>({data:{job_id:'5cd0a089-6758-4f03-834e-5d3fb3073015',stripe_card_id:'ic_test',currency_code:'GBP'},error:null}),maybeSingle:async()=>({data:mocks.approval?{job_id:'5cd0a089-6758-4f03-834e-5d3fb3073015',stripe_card_id:'ic_test',approved:true}:null,error:null})})}}));
import { AdminIssuingTerminalService } from '../../server/services/admin-issuing-terminal.service';
describe('admin issued-card test checkout',()=>{
 beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('STRIPE_SECRET_KEY','sk_test_example');vi.stubEnv('STRIPE_ISSUING_ENABLED','true');vi.stubEnv('STRIPE_ISSUING_FAIL_CLOSED_CONFIRMED','true');mocks.approval=true;
  mocks.balance.mockResolvedValue({livemode:false});mocks.card.mockResolvedValue({id:'ic_test',livemode:false,status:'active',currency:'gbp'});mocks.create.mockResolvedValue({id:'iauth_test',approved:true,livemode:false});mocks.capture.mockResolvedValue({});
  vi.stubGlobal('fetch',async(url:string,options:any)=>({ok:true,json:async()=>String(url).endsWith('/authorizations')?
   mocks.create(Object.fromEntries(new URLSearchParams(options.body)),options.headers):mocks.capture(url,Object.fromEntries(new URLSearchParams(options.body)),options.headers)}));
 });
 afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
 it('authorizes and captures a GBP1 simulated shop purchase',async()=>{
  expect((await AdminIssuingTerminalService.purchase('admin',{jobId,requestId,amount:1})).captured).toBe(true);
  expect(mocks.create.mock.calls[0][0]).toMatchObject({amount:'100',currency:'gbp',card:'ic_test'});
  expect(mocks.capture.mock.calls[0][1]).toEqual({capture_amount:'100',close_authorization:'true'});
 });
 it('never simulates a live card purchase',async()=>{
  vi.stubEnv('STRIPE_SECRET_KEY','sk_live_example');mocks.balance.mockResolvedValue({livemode:true});
  await expect(AdminIssuingTerminalService.purchase('admin',{jobId,requestId,amount:1})).rejects.toThrow('Live cards');expect(mocks.create).not.toHaveBeenCalled();
 });
 it('does not force-capture a declined authorization',async()=>{
  mocks.create.mockResolvedValue({id:'iauth_test',approved:false,livemode:false});
  expect((await AdminIssuingTerminalService.purchase('admin',{jobId,requestId,amount:1})).captured).toBe(false);expect(mocks.capture).not.toHaveBeenCalled();
 });
 it('requires verified approval from the Movabi webhook',async()=>{
  mocks.approval=false;await expect(AdminIssuingTerminalService.purchase('admin',{jobId,requestId,amount:1})).rejects.toThrow('No capture performed');expect(mocks.capture).not.toHaveBeenCalled();
 });
 it('uses the same Stripe idempotency keys for a retry',async()=>{
  await AdminIssuingTerminalService.purchase('admin',{jobId,requestId,amount:1});await AdminIssuingTerminalService.purchase('admin',{jobId,requestId,amount:1});
  expect(mocks.create.mock.calls[0][1]).toEqual(mocks.create.mock.calls[1][1]);expect(mocks.capture.mock.calls[0][2]).toEqual(mocks.capture.mock.calls[1][2]);
 });
 it('rejects invalid amounts and unconfirmed fallback before purchase',async()=>{
  await expect(AdminIssuingTerminalService.purchase('admin',{jobId,requestId,amount:-1})).rejects.toThrow('amount');
  vi.stubEnv('STRIPE_ISSUING_FAIL_CLOSED_CONFIRMED','false');await expect(AdminIssuingTerminalService.purchase('admin',{jobId,requestId,amount:1})).rejects.toThrow('fail-closed');expect(mocks.create).not.toHaveBeenCalled();
 });
});

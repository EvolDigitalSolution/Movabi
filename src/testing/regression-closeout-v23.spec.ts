import {describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runMethod} from './source-contract';
import {userFacingError} from '../app/shared/utils/http-failure';
const read=(path:string)=>readFileSync(path,'utf8').replace(/\r\n/g,'\n');
const dashboard=read('src/app/apps/mobile/features/driver/dashboard/dashboard.page.ts');
describe('dashboard Stripe failure handling',()=>{
  it('hides raw provider errors and dismisses loading after a failed link request',async()=>{
    const toast=vi.fn(),dismiss=vi.fn(),close=vi.fn(),open=vi.fn();
    await runMethod(dashboard,'openStripeDashboard',{
      stripeDashboardOpening:false,stripeUiState:()=>({accountId:'acct_test'}),
      connectService:{prepareDashboardTab:()=>({close}),getDashboardLink:async()=>{throw Error('Stripe connection failed: internal request token');},openDashboard:open},
      loadingCtrl:{create:async()=>({present:async()=>{},dismiss})},showToast:toast
    },[],{userFacingError});
    expect(toast).toHaveBeenCalledWith('Failed to open Stripe dashboard','danger');
    expect(dismiss).toHaveBeenCalledTimes(1);expect(close).toHaveBeenCalledTimes(1);expect(open).not.toHaveBeenCalled();
  });
});
const reconcile=read('supabase_incremental_schema_reconcile.sql');
const migration=read('supabase/migrations/20261237000000_driver_opportunity_lifecycle_guard.sql');
function opportunityFunction(source:string):string{
  const start=source.indexOf('CREATE OR REPLACE FUNCTION public.fetch_hybrid_opportunities(');
  if(start<0)throw Error('Opportunity function missing');
  const end=source.indexOf('\n$$;',start);
  if(end<0)throw Error('Opportunity function terminator missing');
  return source.slice(start,end+4);
}
describe('reconcile preserves the current negotiation discovery contract',()=>{
  it('matches the complete latest checked-in opportunity function',()=>{
    expect(opportunityFunction(reconcile)).toBe(opportunityFunction(migration));
  });
  it.each(['driver_vehicle_can_accept_job(uuid,uuid)','release_stale_negotiation_lease(uuid)','expire_unpaid_fare_agreement(uuid)'])('requires prerequisite %s before replacing discovery',signature=>{
    const prerequisite=reconcile.indexOf(`to_regprocedure('public.${signature}') IS NULL`);
    expect(prerequisite).toBeGreaterThan(-1);
    expect(prerequisite).toBeLessThan(reconcile.indexOf('CREATE OR REPLACE FUNCTION public.fetch_hybrid_opportunities('));
  });
  it('retains authenticated/service ACLs and revokes public/anonymous execution',()=>{
    expect(reconcile).toContain('REVOKE ALL ON FUNCTION public.fetch_hybrid_opportunities(UUID) FROM PUBLIC;');
    expect(reconcile).toContain('REVOKE EXECUTE ON FUNCTION public.fetch_hybrid_opportunities(UUID) FROM anon;');
    expect(reconcile).toContain('GRANT EXECUTE ON FUNCTION public.fetch_hybrid_opportunities(UUID) TO authenticated, service_role;');
  });
});

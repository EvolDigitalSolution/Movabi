import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({retrieve:vi.fn(),balance:vi.fn(),rpc:vi.fn(),record:{id:'request',job_id:'job',new_intent_id:'pi_new',old_intent_id:'pi_old',total_budget:40,status:'created'}}));
vi.mock('../../server/services/stripe.service',()=>({stripe:{paymentIntents:{retrieve:mocks.retrieve},balance:{retrieve:mocks.balance}}}));
vi.mock('../../server/services/supabase.service',()=>({supabaseAdmin:{rpc:mocks.rpc,from:()=>({select(){return this;},eq(){return this;},single:async()=>({data:mocks.record,error:null})})}}));
import { ShoppingBudgetService } from '../../server/services/shopping-budget.service';
import { PaymentAuthorityService } from '../../server/services/payment-authority.service';
describe('shopping card approval',()=>{
 beforeEach(()=>{
  vi.restoreAllMocks();mocks.rpc.mockReset();mocks.retrieve.mockReset();
  vi.spyOn(ShoppingBudgetService,'context').mockResolvedValue({job:{id:'job',currency_code:'GBP'},funding:{over_budget_status:'requested'}});
  vi.spyOn(PaymentAuthorityService,'resolve').mockResolvedValue({serviceFareMajor:10,itemBudgetMajor:30,totalAuthorisationMajor:40,currency:'gbp'});
  vi.spyOn(ShoppingBudgetService,'assertSustainableBudget').mockResolvedValue();
  vi.spyOn(ShoppingBudgetService,'reserve').mockResolvedValue(100);
  vi.spyOn(ShoppingBudgetService,'cleanup').mockResolvedValue();
  mocks.retrieve.mockResolvedValue({id:'pi_new',status:'requires_capture',capture_method:'manual',metadata:{requestId:'request',jobId:'job'},currency:'gbp',amount_capturable:5000});
  mocks.rpc.mockResolvedValue({error:null});
 });
 it('requires the full revised amount before updating the budget',async()=>{
  mocks.retrieve.mockResolvedValue({id:'pi_new',status:'requires_capture',capture_method:'manual',metadata:{requestId:'request',jobId:'job'},currency:'gbp',amount_capturable:4000});
  await expect(ShoppingBudgetService.approve('job','customer','request')).rejects.toThrow('not ready');expect(mocks.rpc).not.toHaveBeenCalled();
 });
 it('does not accept another currency',async()=>{
  mocks.retrieve.mockResolvedValue({id:'pi_new',status:'requires_capture',capture_method:'manual',metadata:{requestId:'request',jobId:'job'},currency:'usd',amount_capturable:5000});
  await expect(ShoppingBudgetService.approve('job','customer','request')).rejects.toThrow('not ready');expect(mocks.rpc).not.toHaveBeenCalled();
 });
 it('does not accept an automatically captured payment',async()=>{
  mocks.retrieve.mockResolvedValue({id:'pi_new',status:'succeeded',capture_method:'automatic',metadata:{requestId:'request',jobId:'job'},currency:'gbp',amount_capturable:5000});
  await expect(ShoppingBudgetService.approve('job','customer','request')).rejects.toThrow('not ready');expect(mocks.rpc).not.toHaveBeenCalled();
 });
 it('commits the verified authorization and rechecks reserve availability',async()=>{
  await ShoppingBudgetService.approve('job','customer','request');
  expect(ShoppingBudgetService.reserve).toHaveBeenCalledWith('job',40,'GBP');
  expect(mocks.rpc).toHaveBeenCalledWith('approve_card_errand_budget',expect.objectContaining({p_old_intent:'pi_old',p_new_intent:'pi_new',p_budget:40,p_available:100}));
 });
 it('leaves the current budget intact when reserve capacity is insufficient',async()=>{
  vi.mocked(ShoppingBudgetService.reserve).mockRejectedValue(new Error('Insufficient issuing funds'));
  await expect(ShoppingBudgetService.approve('job','customer','request')).rejects.toThrow('Insufficient');expect(mocks.rpc).not.toHaveBeenCalled();
 });
 it('does not approve a budget that undermines protected margin',async()=>{
  vi.mocked(ShoppingBudgetService.assertSustainableBudget).mockRejectedValue(new Error('Revised quote required'));
  await expect(ShoppingBudgetService.approve('job','customer','request')).rejects.toThrow('Revised quote');expect(mocks.rpc).not.toHaveBeenCalled();
 });

});

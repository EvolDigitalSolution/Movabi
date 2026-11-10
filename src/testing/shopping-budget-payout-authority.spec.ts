import {afterEach,expect,it,vi} from 'vitest';
vi.mock('../../server/services/stripe.service',()=>({stripe:{}}));
const db=vi.hoisted(()=>({job:{} as any}));
vi.mock('../../server/services/supabase.service',()=>({supabaseAdmin:{from:()=>({select(){return this;},eq(){return this;},single:async()=>({data:db.job})})}}));
import {ShoppingBudgetService} from '../../server/services/shopping-budget.service';
import {FareSplitService} from '../../server/services/fare-split.service';
import {PaymentAuthorityService} from '../../server/services/payment-authority.service';
import {PaymentMarginService} from '../../server/services/payment-margin.service';
afterEach(()=>vi.restoreAllMocks());
const job={payment_method:'card',currency_code:'GBP',fare_breakdown:{}};
function valid(){vi.spyOn(FareSplitService,'fromSnapshot').mockReturnValue({driverEntitlement:7.68} as any);vi.spyOn(PaymentAuthorityService,'resolve').mockResolvedValue({serviceFareMajor:9} as any);return vi.spyOn(PaymentMarginService,'evaluate').mockReturnValue({passes:true} as any);}
it('uses frozen entitlement before driver_payout is populated',async()=>{const margin=valid();await ShoppingBudgetService.assertSustainableBudget(job,20);expect(margin).toHaveBeenCalledWith(9,7.68,20,expect.anything());});
it('still blocks a missing frozen snapshot',async()=>{valid();vi.mocked(FareSplitService.fromSnapshot).mockImplementation(()=>{throw Error('missing');});await expect(ShoppingBudgetService.assertSustainableBudget(job,20)).rejects.toThrow('terms require review');});
it('rejects a conflicting stored payout',async()=>{valid();await expect(ShoppingBudgetService.assertSustainableBudget({...job,driver_payout:8},20)).rejects.toThrow('terms require review');});
it('keeps the processing margin guard',async()=>{valid().mockReturnValue({passes:false} as any);await expect(ShoppingBudgetService.assertSustainableBudget(job,500)).rejects.toThrow('revised service quote');});
it('accepts a consistent stored payout',async()=>{valid();await expect(ShoppingBudgetService.assertSustainableBudget({...job,driver_payout:7.68},20)).resolves.toBeUndefined();});

it.each(['completed','cancelled'])('rejects changes to %s bookings before preparing funding',async status=>{db.job={status,customer_id:'customer'};await expect(ShoppingBudgetService.context('job','customer')).rejects.toThrow('booking has ended');});

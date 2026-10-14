import {expect,it} from 'vitest';
import {driverPaidNegotiation as ready} from '../app/shared/utils/driver-paid-negotiation';
it.each(['assigned','accepted','shopping_in_progress','in_progress','delivered'])('recognises confirmed payment after progression to %s',status=>{expect(ready({status,payment_status:'authorized',driver_id:'driver'},'driver')).toBe(true);});
it.each(['paid','captured'])('recognises %s payment',payment_status=>{expect(ready({status:'accepted',payment_status,driver_id:'driver'},'driver')).toBe(true);});
it.each(['pending','failed','requires_action'])('does not infer confirmation from %s',payment_status=>{expect(ready({status:'assigned',payment_status,driver_id:'driver'},'driver')).toBe(false);});
it('does not trust fare agreement alone',()=>{expect(ready({status:'fare_agreed',payment_status:'authorized',driver_id:'driver'},'driver')).toBe(false);});
it('does not allow another driver',()=>{expect(ready({status:'accepted',payment_status:'paid',driver_id:'other'},'driver')).toBe(false);});
it.each(['cancelled','completed','expired'])('does not reopen %s jobs',status=>{expect(ready({status,payment_status:'paid',driver_id:'driver'},'driver')).toBe(false);});

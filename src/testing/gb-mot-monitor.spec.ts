import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({rpc:vi.fn(),from:vi.fn(),lookup:vi.fn(),enabled:vi.fn()}));
vi.mock('../../server/services/supabase.service',()=>({supabaseAdmin:{rpc:mocks.rpc,from:mocks.from}}));
vi.mock('../../server/services/gb-mot.service',()=>({GbMotService:{lookup:mocks.lookup,enabled:mocks.enabled}}));
import {GbMotMonitorService as Monitor} from '../../server/services/gb-mot-monitor.service';
beforeEach(()=>{vi.resetAllMocks();mocks.enabled.mockReturnValue(true);});
it('uses UK daylight saving',()=>{expect(Monitor.londonClock(new Date('2026-07-01T01:30:00Z'))).toEqual({day:'2026-07-01',minutes:150});expect(Monitor.londonClock(new Date('2026-12-01T02:30:00Z'))).toEqual({day:'2026-12-01',minutes:150});});
it('waits for the nightly window',async()=>{await Monitor.tick(new Date('2026-12-01T02:29:00Z'));expect(mocks.rpc).not.toHaveBeenCalled();});
it('does not run when disabled',async()=>{mocks.enabled.mockReturnValue(false);await Monitor.tick(new Date('2026-12-01T03:00:00Z'));expect(mocks.rpc).not.toHaveBeenCalled();});
it('honours another replica or completed run',async()=>{mocks.rpc.mockResolvedValueOnce({data:null}).mockResolvedValueOnce({data:false});await Monitor.tick(new Date('2026-12-01T03:00:00Z'));expect(mocks.from).not.toHaveBeenCalled();});
it('surfaces storage failures',async()=>{mocks.rpc.mockResolvedValue({error:{message:'failed'}});await expect(Monitor.record('vehicle',{registration:'AB12CDE',motStatus:'valid',motExpiryDate:'2027-01-01',checkedAt:'2026-12-01T03:00:00Z'} as any)).rejects.toThrow('evidence');});
it('atomically records verified evidence',async()=>{mocks.rpc.mockResolvedValue({data:null});await Monitor.record('vehicle',{registration:'AB12CDE',motStatus:'expired',motExpiryDate:'2026-01-01',checkedAt:'2026-12-01T03:00:00Z'} as any);expect(mocks.rpc).toHaveBeenCalledWith('record_gb_vehicle_mot',expect.objectContaining({p_vehicle_id:'vehicle',p_status:'expired',p_expiry:'2026-01-01'}));});
function fleet(type='car',checkedAt:string|null=null) {
 mocks.rpc.mockResolvedValueOnce({data:null}).mockResolvedValueOnce({data:true}).mockResolvedValue({data:null});
 mocks.from.mockImplementation((table:string)=>{
  const result=table==='profiles'?{data:[{id:'driver'}]}:table==='vehicles'?{data:[{id:'vehicle',type,license_plate:'AB12CDE'}]}:table==='driver_vehicle_mot_checks'?{data:checkedAt?{checked_at:checkedAt}:null}:{data:null};
  const chain:any={then:(resolve:any)=>Promise.resolve(result).then(resolve)};
  for(const method of ['select','eq','order','range','maybeSingle','update'])chain[method]=vi.fn(()=>chain);
  return chain;
 });
}
it('keeps failed checks pending without writing false validity',async()=>{
 fleet();mocks.lookup.mockRejectedValue(Error('offline'));const log=vi.spyOn(console,'error').mockImplementation(()=>{});
 await Monitor.tick(new Date('2026-12-01T03:00:00Z'));
 expect(mocks.rpc).not.toHaveBeenCalledWith('record_gb_vehicle_mot',expect.anything());expect(mocks.from).not.toHaveBeenCalledWith('gb_mot_night_runs');log.mockRestore();
});
it('checks a car and completes the nightly run',async()=>{
 fleet();mocks.lookup.mockResolvedValue({registration:'AB12CDE',motStatus:'valid',motExpiryDate:'2027-01-01',checkedAt:'2026-12-01T03:00:00Z'});
 await Monitor.tick(new Date('2026-12-01T03:00:00Z'));expect(mocks.rpc).toHaveBeenCalledWith('record_gb_vehicle_mot',expect.objectContaining({p_status:'valid'}));expect(mocks.from).toHaveBeenCalledWith('gb_mot_night_runs');
});
it('skips motorcycles',async()=>{fleet('motorcycle');await Monitor.tick(new Date('2026-12-01T03:00:00Z'));expect(mocks.lookup).not.toHaveBeenCalled();});
it('does not repeat a successful check on the same UK day',async()=>{fleet('car','2026-12-01T02:45:00Z');await Monitor.tick(new Date('2026-12-01T03:00:00Z'));expect(mocks.lookup).not.toHaveBeenCalled();});

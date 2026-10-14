import {expect,it} from 'vitest';
import {demandZones} from '../../server/services/admin-demand-map.service';
it('groups requests without overlapping duplicate zones',()=>{const z=demandZones([{pickup_lat:53.501,pickup_lng:-2.201},{pickup_lat:53.502,pickup_lng:-2.202}],[]);expect(z).toHaveLength(1);expect(z[0].demand).toBe(2);});
it('shows driver activity even without demand',()=>{expect(demandZones([],[{id:'a',lat:53.501,lng:-2.201,is_available:true}])[0]).toMatchObject({demand:0,drivers:1});});
it('does not count busy drivers as available supply',()=>{expect(demandZones([],[{id:'a',lat:53.5,lng:-2.2,is_available:false}])[0]).toMatchObject({drivers:0,busyDrivers:1});});
it('deduplicates a driver across location rows',()=>{const d={id:'a',lat:53.5,lng:-2.2,is_available:true};expect(demandZones([],[d,d])[0].drivers).toBe(1);});
it('rejects missing, invalid and default coordinates',()=>{expect(demandZones([{pickup_lat:null,pickup_lng:0},{pickup_lat:0,pickup_lng:0},{pickup_lat:100,pickup_lng:1}],[])).toEqual([]);});

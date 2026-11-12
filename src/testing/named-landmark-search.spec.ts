import {beforeEach,describe,it,expect,vi} from 'vitest';import {firstValueFrom,of} from 'rxjs';
// The terminal integration tests (MapTiler client pipeline) moved with the app to the server-backed search (/api/maps-v23). Their behavioural
// requirements are carried by src/testing/server-place-search.spec.ts (mapping: docs/ROADMAP_COMPLETION_MATRIX.md,
// "Address search (D11)"). The tests below cover helpers that the server path still uses.
import {localPlacePlan,landmarkTerminal} from '../app/shared/utils/local-place-search';
const m=vi.hoisted(()=>({get:vi.fn(),country:{code:'GB',name:'United Kingdom',defaultCenter:{lat:51.5,lng:-.12}}}));
vi.mock('@angular/core',()=>({Injectable:()=>()=>{},inject:()=>({get:m.get,getOpenRouteServiceApiKey:()=> 'test',getMapTilerApiKey:()=> 'test',currentCountry:()=>m.country})}));
vi.mock('@angular/common/http',()=>({HttpClient:class{}}));vi.mock('../app/core/services/maps/map-provider.service',()=>({MapProviderService:class{}}));vi.mock('../app/core/services/config/app-config.service',()=>({AppConfigService:class{}}));
import {GeocodingService} from '../app/core/services/maps/geocoding.service';
const origin={lat:53.58173,lng:-2.40783};
const poi=(text:string,lat:number,lng:number)=>({text,place_name:text+', Ringway, United Kingdom',center:[lng,lat],place_type:['poi']});
beforeEach(()=>{m.get.mockReset().mockReturnValue(of({features:[]}));m.country={code:'GB',name:'United Kingdom',defaultCenter:{lat:51.5,lng:-.12}};});
describe('named landmarks versus nearby discovery',()=>{
 it.each(['Manchester Airport Terminal 2','Heathrow Terminal 5','Heathrow T5','Manchester Piccadilly Station','Royal Bolton Hospital','University of Manchester Museum','Old Trafford Stadium'])('does not fence a named destination into 10 km: %s',query=>{expect(localPlacePlan(query,origin)).toMatchObject({localPlace:false,radiusKm:null,needsLocation:false,namedLandmark:true});});
 it.each(['Manchester Airport Terminal 2 near me','airport near me','nearest airport','international airport','railway station','terminal 2','African restaurant near me','Tesco'])('keeps local discovery bounded: %s',query=>{expect(localPlacePlan(query,origin)).toMatchObject({localPlace:true,radiusKm:10});});
 it('does not require GPS just to search a named destination',()=>{expect(localPlacePlan('Manchester Airport Terminal 2')).toMatchObject({needsLocation:false,radiusKm:null});});
 it('preserves street-address classification',()=>{expect(localPlacePlan('10 Manchester Airport Road',origin)).toMatchObject({localPlace:false,radiusKm:null});});
 it.each([['Terminal 2','2'],['T2','2'],['Terminal Two','2'],['Terminal II','2'],['Terminal 20','20'],['Terminal 2A','2a'],['Terminal 02','2']])('normalizes terminal identity %s', (text,number)=>{expect(landmarkTerminal(text)).toBe(number);});
});

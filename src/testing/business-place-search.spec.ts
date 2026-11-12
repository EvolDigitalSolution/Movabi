import {beforeEach,describe,it,expect,vi} from 'vitest';import {firstValueFrom,of,throwError} from 'rxjs';
// The provider-request business tests (MapTiler/ORS client pipeline) moved with the app to the server-backed search (/api/maps-v23). Their behavioural
// requirements are carried by src/testing/server-place-search.spec.ts (mapping: docs/ROADMAP_COMPLETION_MATRIX.md,
// "Address search (D11)"). The tests below cover helpers that the server path still uses.
const m=vi.hoisted(()=>({get:vi.fn(),country:{code:'GB',name:'United Kingdom',defaultCenter:{lat:51.5,lng:-.12}},ors:true,tiler:true}));
vi.mock('@angular/core',()=>({Injectable:()=>()=>{},inject:()=>({get:m.get,getOpenRouteServiceApiKey:()=>m.ors?'test':'',getMapTilerApiKey:()=>m.tiler?'test':'',currentCountry:()=>m.country})}));
vi.mock('@angular/common/http',()=>({HttpClient:class{}}));vi.mock('../app/core/services/maps/map-provider.service',()=>({MapProviderService:class{}}));vi.mock('../app/core/services/config/app-config.service',()=>({AppConfigService:class{}}));
import {GeocodingService} from '../app/core/services/maps/geocoding.service';
const origin={lat:53.58,lng:-2.43};
const poi=(name:string,lat:number,lng:number)=>({text:name,place_name:`${name}, Town, United Kingdom`,center:[lng,lat]});
beforeEach(()=>{m.get.mockReset().mockReturnValue(of({features:[]}));m.country={code:'GB',name:'United Kingdom',defaultCenter:{lat:51.5,lng:-.12}};m.ors=true;m.tiler=true;});
describe('business and point-of-interest search',()=>{
 it('ranks an exact numbered address above a nearer partial address',()=>{const s:any=new GeocodingService();const results=s.rankResults([{label:'10 High Street, Bolton',lat:53.7,lng:-2.43},{label:'20 High Street, Bolton',lat:53.58,lng:-2.43}],'10 High Street',false,origin);expect(results[0].label).toContain('10 High Street');});
});

import {beforeEach,describe,it,expect,vi} from 'vitest';import {firstValueFrom,of,throwError,NEVER} from 'rxjs';
// The provider-request tests (MapTiler/ORS client pipeline) moved with the app to the server-backed search (/api/maps-v23). Their behavioural
// requirements are carried by src/testing/server-place-search.spec.ts (mapping: docs/ROADMAP_COMPLETION_MATRIX.md,
// "Address search (D11)"). The tests below cover helpers that the server path still uses.
import {localPlacePlan,searchDistanceKm,searchBoundingBox,placeCategory,categoryMatch} from '../app/shared/utils/local-place-search';
const m=vi.hoisted(()=>({get:vi.fn(),keys:true,country:{code:'GB',name:'United Kingdom',defaultCenter:{lat:51.5,lng:-.12}}}));
vi.mock('@angular/core',()=>({Injectable:()=>()=>{},inject:()=>({get:m.get,getOpenRouteServiceApiKey:()=>m.keys?'test':'',getMapTilerApiKey:()=>m.keys?'test':'',currentCountry:()=>m.country})}));
vi.mock('@angular/common/http',()=>({HttpClient:class{}}));vi.mock('../app/core/services/maps/map-provider.service',()=>({MapProviderService:class{}}));vi.mock('../app/core/services/config/app-config.service',()=>({AppConfigService:class{}}));
import {GeocodingService} from '../app/core/services/maps/geocoding.service';
const origin={lat:53.58,lng:-2.43};const feature=(lat:number,name='African Restaurant',cuisine='african')=>({text:name,place_name:name+', Town',center:[-2.43,lat],place_type:['poi'],properties:{categories:['restaurant'],feature_tags:{cuisine}}});
beforeEach(()=>{m.keys=true;m.country={code:'GB',name:'United Kingdom',defaultCenter:{lat:51.5,lng:-.12}};m.get.mockReset().mockReturnValue(of({features:[]}));});
describe('local search policy and geometry',()=>{
 it('requires a real location for a local shop search instead of using the country capital',()=>{expect(localPlacePlan('African restaurant')).toMatchObject({needsLocation:true,radiusKm:10});});
 it('only widens after an explicit scope choice',()=>{expect(localPlacePlan('Tesco',origin).radiusKm).toBe(10);expect(localPlacePlan('Tesco',origin,25).radiusKm).toBe(25);expect(localPlacePlan('Tesco',origin,'country').radiusKm).toBeNull();});
 it.each(['10 High Street','Labuka, London','African restaurant in London'])('preserves explicit address/area search: %s',query=>{expect(localPlacePlan(query,origin).radiusKm).toBeNull();});
 it('preserves postcode lookup and near-me explicitly opts into locality',()=>{expect(localPlacePlan('BL1 1AA',origin,10,true).radiusKm).toBeNull();expect(localPlacePlan('Tesco near me',origin).radiusKm).toBe(10);});
 it('normalises the users Africa/restuarant category without inventing a business',()=>{expect(localPlacePlan('Africa restuarant',origin).query).toBe('African restaurant');expect(placeCategory('African restaurant')).toEqual({kind:'restaurant',qualifier:'african'});});
 it('uses recorded cuisine metadata for a restaurant whose name is not African',()=>{const cat=placeCategory('African restaurant')!;expect(categoryMatch(cat,{label:'The Buka',categories:['restaurant'],placeTags:{cuisine:'nigerian'}})).toBe(true);expect(categoryMatch(cat,{label:'Sushi House',categories:['restaurant'],placeTags:{cuisine:'japanese'}})).toBe(false);});
 it('handles equator, longitude zero, polar and date-line geometry',()=>{expect(searchDistanceKm({lat:0,lng:179.99},{lat:0,lng:-179.99})).toBeLessThan(3);expect(searchBoundingBox({lat:0,lng:0},10)).not.toBeNull();expect(searchBoundingBox({lat:89.99,lng:0},10)).not.toBeNull();expect(searchBoundingBox({lat:0,lng:179.99},10)).toBeNull();});
 it('does not accept invalid GPS coordinates as a real local anchor',()=>{expect(localPlacePlan('Tesco',{lat:NaN,lng:0}).needsLocation).toBe(true);expect(localPlacePlan('Tesco',{lat:91,lng:0}).needsLocation).toBe(true);});
});

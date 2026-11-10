import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { GbMotService } from '../../server/services/gb-mot.service';
const now=new Date('2026-10-14T12:00:00Z');
const vehicle=(tests:any[]=[])=>({registration:'AB12CDE',make:'FORD',model:'FOCUS',primaryColour:'BLUE',manufactureDate:'2012-01-01',motTests:tests});
describe('GB MOT lookup mapping and region policy',()=>{
 afterEach(()=>vi.unstubAllEnvs());
 it('enables only GB when the backend switch is enabled',()=>{vi.stubEnv('DVSA_MOT_ENABLED','true');expect(GbMotService.enabled('GB')).toBe(true);expect(GbMotService.enabled('NG')).toBe(false);expect(GbMotService.enabled('US')).toBe(false);});
 it('retains manual onboarding when disabled',()=>{vi.stubEnv('DVSA_MOT_ENABLED','false');expect(GbMotService.enabled('GB')).toBe(false);});
 it('normalizes a spaced plate and rejects unsafe input',()=>{expect(GbMotService.plate('ab12 cde')).toBe('AB12CDE');expect(()=>GbMotService.plate('../vehicles')).toThrow('valid GB');});
 it('returns details and an unexpired MOT',()=>{const r=GbMotService.normalize(vehicle([{completedDate:'2026-01-01',testResult:'PASSED',expiryDate:'2027-01-01'}]),'AB12CDE',now);expect(r).toMatchObject({make:'FORD',model:'FOCUS',year:2012,motStatus:'valid',motExpiryDate:'2027-01-01'});});
 it('treats expiry day as valid in the UK calendar',()=>{expect(GbMotService.normalize(vehicle([{completedDate:'2025-10-15',testResult:'PASSED',expiryDate:'2026-10-14'}]),'AB12CDE',now).motStatus).toBe('valid');});
 it('marks expired MOTs',()=>{expect(GbMotService.normalize(vehicle([{completedDate:'2025-01-01',testResult:'PASSED',expiryDate:'2026-01-01'}]),'AB12CDE',now).motStatus).toBe('expired');});
 it('sorts tests and identifies a latest dangerous failure over an earlier pass',()=>{expect(GbMotService.normalize(vehicle([{completedDate:'2026-01-01',testResult:'PASSED',expiryDate:'2027-01-01'},{completedDate:'2026-10-01',testResult:'FAILED',defects:[{dangerous:true}]}]),'AB12CDE',now).motStatus).toBe('dangerous_failure');});
 it('does not fabricate validity for a vehicle without tests',()=>{expect(GbMotService.normalize(vehicle(),'AB12CDE',now).motStatus).toBe('unknown');});
 it('does not confuse first registration with manufacture year',()=>{const v:any=vehicle();delete v.manufactureDate;v.registrationDate='2020-01-01';expect(GbMotService.normalize(v,'AB12CDE',now).year).toBeNull();});
 it('rejects a mismatched registration',()=>{expect(()=>GbMotService.normalize(vehicle(),'XY12XYZ',now)).toThrow('match');});
});
describe('DVSA authentication and API failures',()=>{
 beforeEach(()=>{vi.stubEnv('DVSA_MOT_CLIENT_ID','example-client');vi.stubEnv('DVSA_MOT_CLIENT_SECRET','example-secret');vi.stubEnv('DVSA_MOT_TOKEN_URL','https://login.microsoftonline.com/example-tenant/oauth2/v2.0/token');vi.stubEnv('DVSA_MOT_SCOPE','https://tapi.dvsa.gov.uk/.default');vi.stubEnv('DVSA_MOT_API_KEY','example-api-key');});
 afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
 it('caches OAuth tokens and uses both required authorization headers',async()=>{
  vi.resetModules();const {GbMotService:S}=await import('../../server/services/gb-mot.service');const calls:any[]=[];
  vi.stubGlobal('fetch',async(url:any,options:any)=>{calls.push({url:String(url),options});return {ok:true,status:200,json:async()=>String(url).includes('microsoftonline')?{access_token:'example-token',expires_in:3600}:vehicle()};});
  await S.lookup('AB12 CDE');await S.lookup('AB12CDE');expect(calls.filter(c=>c.url.includes('microsoftonline'))).toHaveLength(1);expect(calls[1].options.headers).toMatchObject({Authorization:'Bearer example-token','X-API-Key':'example-api-key'});
 });
 it('does not turn a provider outage into a verified result',async()=>{
  vi.resetModules();const {GbMotService:S}=await import('../../server/services/gb-mot.service');vi.stubGlobal('fetch',async(url:any)=>({ok:String(url).includes('microsoftonline'),status:503,json:async()=>({access_token:'example-token',expires_in:3600})}));await expect(S.lookup('AB12CDE')).rejects.toThrow('temporarily unavailable');
 });
});

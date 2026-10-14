export interface GbVehicleLookup {
 registration:string;make:string|null;model:string|null;colour:string|null;year:number|null;
 fuelType:string|null;motExpiryDate:string|null;latestResult:string|null;
 motStatus:'valid'|'expired'|'dangerous_failure'|'unknown';checkedAt:string;source:'DVSA_MOT';
}
export class GbMotService {
 private static token:{value:string;expires:number}|null=null;
 private static pending:Promise<string>|null=null;
 static enabled(country:unknown):boolean { return String(country || '').toUpperCase()==='GB' && process.env.DVSA_MOT_ENABLED==='true'; }
 static plate(value:unknown):string {
  const plate=String(value || '').toUpperCase().replace(/\s/g,'');
  if(!/^[A-Z0-9]{2,8}$/.test(plate)) throw Object.assign(new Error('Enter a valid GB registration number.'),{httpStatus:422});
  return plate;
 }
 private static async accessToken():Promise<string> {
  if(this.token && this.token.expires>Date.now())return this.token.value;
  if(this.pending)return this.pending;
  this.pending=(async()=>{
   const {DVSA_MOT_CLIENT_ID:client,DVSA_MOT_CLIENT_SECRET:secret,DVSA_MOT_TOKEN_URL:tokenUrl,DVSA_MOT_SCOPE:scope,DVSA_MOT_API_KEY:apiKey}=process.env;
   if(!client||!secret||!tokenUrl||!scope||!apiKey)throw Object.assign(new Error('GB vehicle lookup is awaiting configuration. Contact Movabi support.'),{httpStatus:503});
   const url=new URL(tokenUrl);
   if(url.protocol!=='https:'||url.hostname!=='login.microsoftonline.com'||!/^\/[^/]+\/oauth2\/v2\.0\/token$/.test(url.pathname))throw Error('Invalid MOT authentication configuration.');
   const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:client,client_secret:secret,scope}),signal:AbortSignal.timeout(10000)});
   const data=await response.json() as any;
   if(!response.ok||!data.access_token)throw Object.assign(new Error('GB vehicle lookup authentication is unavailable.'),{httpStatus:503});
   this.token={value:data.access_token,expires:Date.now()+Math.max(0,Number(data.expires_in || 0)-60)*1000};return this.token.value;
  })().finally(()=>this.pending=null);
  return this.pending;
 }
 static normalize(data:any,plate:string,now=new Date()):GbVehicleLookup {
  if(!data||this.plate(data.registration)!==plate)throw Object.assign(new Error('The returned vehicle does not match the registration.'),{httpStatus:502});
  const text=(value:unknown)=>typeof value==='string'&&value.trim()?value.trim():null;
  const tests=Array.isArray(data.motTests)?[...data.motTests].sort((a,b)=>String(b.completedDate||'').localeCompare(String(a.completedDate||''))):[];
  const latest=tests[0];const pass=tests.find(t=>String(t.testResult).toUpperCase()==='PASSED' && /^\d{4}-\d{2}-\d{2}$/.test(t.expiryDate || ''));
  const expiry=text(pass?.expiryDate);const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const dangerous=String(latest?.testResult).toUpperCase()==='FAILED' && (latest.defects || []).some((d:any)=>d.dangerous===true || String(d.type).toUpperCase()==='DANGEROUS');
  const year=/^\d{4}-\d{2}-\d{2}$/.test(data.manufactureDate || '')?Number(data.manufactureDate.slice(0,4)):null;
  return {registration:plate,make:text(data.make),model:text(data.model),colour:text(data.primaryColour),year,
   fuelType:text(data.fuelType),motExpiryDate:expiry,latestResult:text(latest?.testResult),
   motStatus:dangerous?'dangerous_failure':expiry?(expiry>=today?'valid':'expired'):'unknown',checkedAt:now.toISOString(),source:'DVSA_MOT'};
 }
 static async lookup(value:unknown):Promise<GbVehicleLookup> {
  const plate=this.plate(value);
  const response=await fetch('https://history.mot.api.gov.uk/v1/trade/vehicles/registration/'+encodeURIComponent(plate),{
   headers:{Authorization:'Bearer '+await this.accessToken(),'X-API-Key':process.env.DVSA_MOT_API_KEY!},signal:AbortSignal.timeout(10000)});
  if(response.status===404)throw Object.assign(new Error('Vehicle not found. Check the registration or contact support for manual review.'),{httpStatus:404});
  if(!response.ok){if(response.status===401)this.token=null;throw Object.assign(new Error('GB vehicle lookup is temporarily unavailable. Please retry.'),{httpStatus:503});}
  return this.normalize(await response.json(),plate);
 }
}

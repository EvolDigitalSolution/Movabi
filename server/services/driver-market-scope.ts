/** Registered operating country and tenant, never display currency or browser GPS. */
export function driverMatchesJobMarket(profile: any, job: any): boolean {
 const country=String(profile?.registration_country_code || profile?.country_code || '').trim().toUpperCase();
 const jobCountry=String(job?.country_code || job?.metadata?.country_code || '').trim().toUpperCase();
 const tenant=String(profile?.tenant_id || ''), jobTenant=String(job?.tenant_id || '');
 return /^[A-Z]{2}$/.test(country) && country===jobCountry && !!tenant && tenant===jobTenant
   && (!job?.metadata?.country_code || String(job.metadata.country_code).toUpperCase()===jobCountry);
}

export async function assertDriverJobMarket(db:any,driverId:string,job:any):Promise<void>{
 const {data:profile,error}=await db.from('profiles').select('*').eq('id',driverId).maybeSingle();
 if(error||!profile||profile.role!=='driver'||!driverMatchesJobMarket(profile,job))
  throw Object.assign(new Error('This request is outside your registered driver market.'),{code:'DRIVER_MARKET_MISMATCH'});
}

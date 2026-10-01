import { supabaseAdmin } from './supabase.service';

export type MarketCapability = 'customer_app'|'customer_registration'|'driver_registration'|'driver_online'|'quote'|'booking'|'payment';
export type MarketResolutionLevel = 'zone'|'city'|'country'|'unavailable';

export interface MarketAvailabilityInput { countryCode?: unknown; marketCity?: unknown; zoneId?: unknown; capability?: MarketCapability; endpoint?: string; }
export interface MarketCapabilities { customerApp:boolean; customerRegistration:boolean; driverRegistration:boolean; driverOnline:boolean; quote:boolean; booking:boolean; payment:boolean; }
export interface ResolvedMarketAvailability {
  countryCode:string|null; marketCity:string|null; zoneId:string|null; launchStatus:string; capabilities:MarketCapabilities;
  currency:string|null; timezone:string|null; title:string|null; message:string|null; waitingListEnabled:boolean; resolutionLevel:MarketResolutionLevel;
}

export class MarketAvailabilityError extends Error {
  constructor(public code:'MARKET_NOT_CONFIGURED'|'MARKET_COMING_SOON'|'MARKET_PAUSED'|'MARKET_CAPABILITY_DISABLED'|'MARKET_LOCATION_UNRESOLVED', public httpStatus:403|422, public market:ResolvedMarketAvailability) {
    super(market.message); this.name='MarketAvailabilityError';
  }
}

const CAPABILITY_COLUMN:Record<MarketCapability,string>={
  customer_app:'customer_app_enabled',customer_registration:'customer_registration_enabled',driver_registration:'driver_registration_enabled',
  driver_online:'driver_online_enabled',quote:'quote_enabled',booking:'booking_enabled',payment:'payment_enabled'
};

export interface MarketCopy{title:string|null;message:string|null;}

/**
 * Truthful customer copy for a capability check.
 *
 * The bug: unavailable copy was returned unconditionally, so a LIVE market with the
 * requested capability ALLOWED still carried:
 *   title:   "Movabi is coming to <city>"
 *   message: "Bookings are not available in this area yet."
 * A live, allowed capability now carries no unavailable copy. The decision lives here --
 * not in resolveMarket -- because only a capability check knows whether the caller is
 * allowed; `GET /markets/status` legitimately still needs the configured banner copy for
 * a live market whose bookings are disabled.
 */
export function marketCopyForCapability(
  launchStatus:string,
  allowed:boolean,
  code:string|null,
  market:{title:string|null;message:string|null;}
):MarketCopy{
  if(allowed&&String(launchStatus)==='live')return {title:null,message:null};
  if(code&&!market.message){
    return {title:market.title??MARKET_CODE_FALLBACK_COPY[code]??null,message:MARKET_CODE_FALLBACK_COPY[code]??null};
  }
  return {title:market.title,message:market.message};
}

/**
 * Truthful customer copy for a rejection on a market that keeps null unavailable copy,
 * i.e. a live market whose requested capability is paused or disabled.
 */
export const MARKET_CODE_FALLBACK_COPY:Record<string,string>={
  MARKET_COMING_SOON:'Movabi is coming to this area.',
  MARKET_PAUSED:'Movabi is temporarily unavailable in this area.',
  MARKET_CAPABILITY_DISABLED:'This service is not available in this area yet.',
  MARKET_LOCATION_UNRESOLVED:'Choose a service location so we can check availability.',
  MARKET_NOT_CONFIGURED:'Bookings are not available in this area yet.'
};

export class MarketAvailabilityService {
  static normalizeCountry(value:unknown):string|null { const v=String(value||'').trim().toUpperCase(); return /^[A-Z]{2}$/.test(v)?v:null; }
  static normalizeCity(value:unknown):string|null { const v=String(value||'').replace(/\s+/g,' ').trim(); return v?v:null; }
  static normalizeZone(value:unknown):string|null { const v=String(value||'').trim(); return v?v:null; }

  /** GB market service bounds: the only coordinates allowed to fall back to GB. */
  static readonly GB_SERVICE_BOUNDS={minLat:49.8,maxLat:60.9,minLng:-8.7,maxLng:2.1} as const;

  /** True only for finite coordinates inside the GB service bounds. */
  static isWithinGbServiceBounds(lat:number,lng:number):boolean {
    const b=MarketAvailabilityService.GB_SERVICE_BOUNDS;
    return Number.isFinite(lat)&&Number.isFinite(lng)
      &&lat>=b.minLat&&lat<=b.maxLat&&lng>=b.minLng&&lng<=b.maxLng;
  }

  /**
   * Resolve the market country for a service location.
   *
   * A city's stored country may only outrank the geographic fallback when it normalizes to a
   * valid ISO alpha-2 code. Previously a truthy-but-malformed value (e.g. country='United
   * Kingdom' on the Manchester row) short-circuited `|| (bounds ? 'GB' : null)`, and
   * normalizeCountry() then rejected it -- so countryCode became null and a journey
   * demonstrably inside the GB service bounds failed with MARKET_LOCATION_UNRESOLVED (422).
   *
   * Client-supplied country is deliberately NOT accepted here: it is presentation context and
   * may not authorize a market. The caller still has to pass requireCapability() afterwards.
   */
  static resolveServiceCountryCode(cityCountry:unknown,lat:number,lng:number):string|null {
    const fromCity=this.normalizeCountry(cityCountry);
    if (fromCity) return fromCity;
    return this.isWithinGbServiceBounds(lat,lng)?'GB':null;
  }

  static async resolveMarket(input:MarketAvailabilityInput):Promise<ResolvedMarketAvailability> {
    const countryCode=this.normalizeCountry(input.countryCode); const marketCity=this.normalizeCity(input.marketCity); const zoneId=this.normalizeZone(input.zoneId);
    if (!countryCode) return this.unavailable(null,marketCity,zoneId,'MARKET_LOCATION_UNRESOLVED');
    let query=supabaseAdmin.from('market_availability').select('*').eq('enabled',true).eq('country_code',countryCode)
      .or(`valid_from.is.null,valid_from.lte.${new Date().toISOString()}`).or(`valid_until.is.null,valid_until.gt.${new Date().toISOString()}`);
    const {data,error}=await query;
    if(error){ console.error('[MarketAvailability] resolve failed',error.message); return this.unavailable(countryCode,marketCity,zoneId,'MARKET_NOT_CONFIGURED'); }
    const rows=(data||[]) as any[];
    const cityLower=marketCity?.toLowerCase();
    const row=(zoneId&&marketCity?rows.find(r=>String(r.zone_id||'')===zoneId&&String(r.market_city||'').trim().toLowerCase()===cityLower):null)
      ||(marketCity?rows.find(r=>!r.zone_id&&String(r.market_city||'').trim().toLowerCase()===cityLower):null)
      ||rows.find(r=>!r.zone_id&&!this.normalizeCity(r.market_city));
    if(!row) return this.unavailable(countryCode,marketCity,zoneId,'MARKET_NOT_CONFIGURED');
    const level:MarketResolutionLevel=row.zone_id?'zone':this.normalizeCity(row.market_city)?'city':'country';
    return {countryCode,marketCity:this.normalizeCity(row.market_city),zoneId:this.normalizeZone(row.zone_id),launchStatus:String(row.launch_status),
      capabilities:{customerApp:!!row.customer_app_enabled,customerRegistration:!!row.customer_registration_enabled,driverRegistration:!!row.driver_registration_enabled,
        driverOnline:!!row.driver_online_enabled,quote:!!row.quote_enabled,booking:!!row.booking_enabled,payment:!!row.payment_enabled},
      currency:row.supported_currency||null,timezone:row.timezone||null,
      title:row.unavailable_title||`Movabi is coming to ${marketCity||countryCode}`,
      message:row.unavailable_message||'Bookings are not available in this area yet.',waitingListEnabled:!!row.waiting_list_enabled,resolutionLevel:level};
  }

  static async checkCapability(input:MarketAvailabilityInput&{capability:MarketCapability}):Promise<{allowed:boolean;market:ResolvedMarketAvailability;code:string|null}> {
    const market=await this.resolveMarket(input); const key=CAPABILITY_COLUMN[input.capability];
    const capabilityMap:any={customer_app:market.capabilities.customerApp,customer_registration:market.capabilities.customerRegistration,
      driver_registration:market.capabilities.driverRegistration,driver_online:market.capabilities.driverOnline,quote:market.capabilities.quote,
      booking:market.capabilities.booking,payment:market.capabilities.payment};
    let code:string|null=null;
    if(market.resolutionLevel==='unavailable') code=market.countryCode?'MARKET_NOT_CONFIGURED':'MARKET_LOCATION_UNRESOLVED';
    else if(market.launchStatus==='paused') code='MARKET_PAUSED'; else if(market.launchStatus==='coming_soon') code='MARKET_COMING_SOON';
    else if(!capabilityMap[input.capability]) code='MARKET_CAPABILITY_DISABLED';
    const allowed=!code;
    // Strip unavailable copy only when this capability is actually allowed on a live market,
    // and backfill a truthful reason when a rejection would otherwise carry no message.
    const copy=marketCopyForCapability(market.launchStatus,allowed,code,market);
    const resolved={...market,...copy};
    const {error}=await supabaseAdmin.from('market_availability_audit').insert({country_code:resolved.countryCode,market_city:resolved.marketCity,zone_id:resolved.zoneId,
      capability:key.replace('_enabled',''),allowed,launch_status:resolved.launchStatus,resolution_level:resolved.resolutionLevel,endpoint:input.endpoint||null,error_code:code});
    if(error) console.error('[MarketAvailability] audit insert failed',error.message);
    return {allowed,market:resolved,code};
  }

  static async requireCapability(input:MarketAvailabilityInput&{capability:MarketCapability}):Promise<ResolvedMarketAvailability> {
    const result=await this.checkCapability(input); if(result.allowed)return result.market;
    const status=result.code==='MARKET_LOCATION_UNRESOLVED'?422:403;
    throw new MarketAvailabilityError(result.code as any,status,result.market);
  }

  private static unavailable(countryCode:string|null,marketCity:string|null,zoneId:string|null,reason:string):ResolvedMarketAvailability {
    return {countryCode,marketCity,zoneId,launchStatus:'coming_soon',capabilities:{customerApp:true,customerRegistration:false,driverRegistration:false,
      driverOnline:false,quote:false,booking:false,payment:false},currency:null,timezone:null,title:`Movabi is coming to ${marketCity||countryCode||'your area'}`,
      message:reason==='MARKET_LOCATION_UNRESOLVED'?'Choose a service location so we can check availability.':'Bookings are not available in this area yet.',waitingListEnabled:true,resolutionLevel:'unavailable'};
  }
}

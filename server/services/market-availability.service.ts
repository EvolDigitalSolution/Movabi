import { supabaseAdmin } from './supabase.service';

export type MarketCapability = 'customer_app'|'customer_registration'|'driver_registration'|'driver_online'|'quote'|'booking'|'payment';
export type MarketResolutionLevel = 'zone'|'city'|'country'|'unavailable';

export interface MarketAvailabilityInput { countryCode?: unknown; marketCity?: unknown; zoneId?: unknown; capability?: MarketCapability; endpoint?: string; }
export interface MarketCapabilities { customerApp:boolean; customerRegistration:boolean; driverRegistration:boolean; driverOnline:boolean; quote:boolean; booking:boolean; payment:boolean; }
export interface ResolvedMarketAvailability {
  countryCode:string|null; marketCity:string|null; zoneId:string|null; launchStatus:string; capabilities:MarketCapabilities;
  currency:string|null; timezone:string|null; title:string; message:string; waitingListEnabled:boolean; resolutionLevel:MarketResolutionLevel;
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

export class MarketAvailabilityService {
  static normalizeCountry(value:unknown):string|null { const v=String(value||'').trim().toUpperCase(); return /^[A-Z]{2}$/.test(v)?v:null; }
  static normalizeCity(value:unknown):string|null { const v=String(value||'').replace(/\s+/g,' ').trim(); return v?v:null; }
  static normalizeZone(value:unknown):string|null { const v=String(value||'').trim(); return v?v:null; }

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
    const {error}=await supabaseAdmin.from('market_availability_audit').insert({country_code:market.countryCode,market_city:market.marketCity,zone_id:market.zoneId,
      capability:key.replace('_enabled',''),allowed,launch_status:market.launchStatus,resolution_level:market.resolutionLevel,endpoint:input.endpoint||null,error_code:code});
    if(error) console.error('[MarketAvailability] audit insert failed',error.message);
    return {allowed,market,code};
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

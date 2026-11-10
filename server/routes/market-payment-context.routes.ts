import {Router,type Request} from 'express';
import {MarketAvailabilityService} from '../services/market-availability.service';
import {readDatabasePaymentAssignment} from '../services/payments/market-payment-store';
export function createMarketPaymentContextRouter(authenticate:(req:Request)=>Promise<string|null>,db:any,
 resolveMarket:typeof MarketAvailabilityService.resolveMarket=MarketAvailabilityService.resolveMarket.bind(MarketAvailabilityService)){
 const router=Router();
 router.get('/',async(req,res)=>{
  res.setHeader('Cache-Control','private, no-store');
  try{
   const userId=await authenticate(req);if(!userId)return res.status(401).json({error:'Please sign in again.'});
   if(process.env.VAYDU_DATABASE_PAYMENT_ROUTING_V23!=='true'&&process.env.VAYDU_GLOBAL_PAYMENT_ROUTING_V23!=='true')return res.status(404).json({error:'Market provider lookup is unavailable.'});
   const {data:profile,error}=await db.from('profiles').select('country_code,registration_market_city').eq('id',userId).single();
   if(error||!profile)return res.status(503).json({error:'Could not resolve your service market.'});
   const market=await resolveMarket({countryCode:profile.country_code,marketCity:profile.registration_market_city});
   if(!market.countryCode||!market.currency)return res.status(409).json({error:'Choose an available service market.'});
   const assignment=await readDatabasePaymentAssignment(db,{country:market.countryCode,currency:market.currency,method:'card'});
   return res.json({...assignment,marketPaymentEnabled:market.launchStatus==='live'&&market.capabilities.payment,
    context:'profile_default',bookingUsesServiceCountry:true});
  }catch{return res.status(503).json({error:'The payment provider mapping is unavailable.'});}
 });
 return router;
}

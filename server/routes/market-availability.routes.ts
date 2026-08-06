import {NextFunction,Request,Response,Router} from 'express';
import {supabaseAdmin} from '../services/supabase.service';
import {MarketAvailabilityError,MarketAvailabilityService,MarketCapability} from '../services/market-availability.service';
import {rateLimit} from 'express-rate-limit';
import {DriverRequirementService} from '../services/driver-requirement.service';
import {DriverOnlineEligibilityService} from '../services/driver-online-eligibility.service';
import {mapDriverVehicleRow} from '../models/driver-vehicle.model';
const router=Router();
const publicResolveLimiter=rateLimit({windowMs:60_000,limit:60,standardHeaders:true,legacyHeaders:false});
const capabilities=new Set<MarketCapability>(['customer_app','customer_registration','driver_registration','driver_online','quote','booking','payment']);
const requireAdmin=async(req:Request,res:Response,next:NextFunction)=>{const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'').trim();
 if(!token)return res.status(401).json({error:'Authentication required'}); const {data}=await supabaseAdmin.auth.getUser(token);
 if(!data.user?.id)return res.status(401).json({error:'Invalid session'}); const {data:profile}=await supabaseAdmin.from('profiles').select('role').eq('id',data.user.id).maybeSingle();
 if(profile?.role!=='admin')return res.status(403).json({error:'Administrator access required'}); return next();};
const authUser=async(req:Request)=>{const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'').trim();if(!token)return null;const{data}=await supabaseAdmin.auth.getUser(token);return data.user?.id||null;};
const publicShape=(m:any,code:string|null=null)=>({code,countryCode:m.countryCode,marketCity:m.marketCity,launchStatus:m.launchStatus,
 customerAppEnabled:m.capabilities.customerApp,customerRegistrationEnabled:m.capabilities.customerRegistration,
 driverRegistrationEnabled:m.capabilities.driverRegistration,driverOnlineEnabled:m.capabilities.driverOnline,quoteEnabled:m.capabilities.quote,
 bookingEnabled:m.capabilities.booking,paymentEnabled:m.capabilities.payment,currency:m.currency,timezone:m.timezone,title:m.title,message:m.message,
 waitingListEnabled:m.waitingListEnabled,resolutionLevel:m.resolutionLevel});
router.get('/status',async(req,res)=>{const market=await MarketAvailabilityService.resolveMarket({countryCode:req.query.countryCode,marketCity:req.query.marketCity,zoneId:req.query.zoneId});res.json(publicShape(market));});
router.post('/resolve',publicResolveLimiter,async(req,res)=>{try{const capability=String(req.body?.capability||'customer_app') as MarketCapability;if(!capabilities.has(capability))return res.status(400).json({error:'Invalid capability'});
 const result=await MarketAvailabilityService.checkCapability({...req.body,capability,endpoint:'/api/markets/resolve'});return res.status(result.allowed?200:(result.code==='MARKET_LOCATION_UNRESOLVED'?422:403)).json(publicShape(result.market,result.code));
 }catch(e:any){return res.status(500).json({error:e.message});}});
router.post('/waitlist',publicResolveLimiter,async(req,res)=>{const email=String(req.body?.email||'').trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return res.status(400).json({error:'Enter a valid email address.'});
 const market=await MarketAvailabilityService.resolveMarket(req.body||{});if(!market.waitingListEnabled)return res.status(403).json({error:'The waiting list is not open for this market.',code:'MARKET_CAPABILITY_DISABLED'});
 if(!market.countryCode)return res.status(422).json({error:'Choose a country first.',code:'MARKET_LOCATION_UNRESOLVED'});const{error}=await supabaseAdmin.from('market_waiting_list').insert({email,country_code:market.countryCode,market_city:market.marketCity});if(error&&error.code!=='23505')return res.status(500).json({error:'Could not join the waiting list.'});return res.json({ok:true});});
router.post('/driver-online',async(req,res)=>{try{const userId=await authUser(req);if(!userId)return res.status(401).json({error:'Authentication required'});
 const online=req.body?.online===true;if(online){const{data:profile,error:profileError}=await supabaseAdmin.from('profiles').select('*').eq('id',userId).single();if(profileError||!profile)throw profileError||new Error('Driver profile not found');
 const{data:vehicles,error:vehicleError}=await supabaseAdmin.from('vehicles').select('*').eq('user_id',userId).order('created_at',{ascending:false});if(vehicleError)throw vehicleError;if((vehicles||[]).length>1)return res.status(409).json({error:'Multiple vehicle records require Admin repair.',code:'DUPLICATE_DRIVER_VEHICLES'});
 const{data:auth}=await supabaseAdmin.auth.admin.getUserById(userId);const market=await MarketAvailabilityService.checkCapability({countryCode:req.body?.countryCode||profile.country_code,marketCity:req.body?.marketCity||profile.market_city||profile.city,zoneId:req.body?.zoneId||profile.zone_id,capability:'driver_online',endpoint:'/api/markets/driver-online'});
 const requirements=DriverRequirementService.resolve({profile,vehicle:(vehicles||[])[0]?mapDriverVehicleRow((vehicles||[])[0]):null,authEmailConfirmed:!!auth.user?.email_confirmed_at,countryCode:profile.country_code});const eligibility=DriverOnlineEligibilityService.evaluate({profile,market,requirements,vehiclePresent:!!(vehicles||[])[0],locationPermission:req.body?.locationPermission});
 if(!eligibility.allowed)return res.status(403).json(eligibility);}
 const{error}=await supabaseAdmin.from('profiles').update({is_online:online,is_available:online,last_active_at:new Date().toISOString()}).eq('id',userId);if(error)return res.status(400).json({error:error.message});return res.json({ok:true,online});
 }catch(error){if(error instanceof MarketAvailabilityError)return res.status(error.httpStatus).json({error:error.message,code:error.code,market:error.market});return res.status(500).json({error:'Unable to update driver availability'});}});
router.post('/driver-registration/check',async(req,res)=>{try{const userId=await authUser(req);if(!userId)return res.status(401).json({error:'Authentication required'});
 const{data:profile}=await supabaseAdmin.from('profiles').select('*').eq('id',userId).maybeSingle();
 if(profile?.role==='driver'&&profile?.onboarding_completed)return res.json({allowed:true,existingDriver:true});
 const market=await MarketAvailabilityService.requireCapability({countryCode:req.body?.countryCode||profile?.country_code,marketCity:req.body?.marketCity||profile?.market_city||profile?.city,zoneId:req.body?.zoneId,capability:'driver_registration',endpoint:'/api/markets/driver-registration/check'});
 return res.json({allowed:true,existingDriver:false,market});
 }catch(error){if(error instanceof MarketAvailabilityError)return res.status(error.httpStatus).json({error:error.message,code:error.code,market:error.market});return res.status(500).json({error:'Unable to verify driver registration availability'});}});
router.get('/admin',requireAdmin,async(_req,res)=>{const{data,error}=await supabaseAdmin.from('market_availability').select('*').order('country_code').order('market_city');if(error)return res.status(500).json({error:error.message});res.json(data);});
router.post('/admin',requireAdmin,async(req,res)=>{const body=req.body||{};const country=MarketAvailabilityService.normalizeCountry(body.country_code??body.countryCode);if(!country)return res.status(400).json({error:'Valid ISO country required'});
 if(body.market_city&&String(body.market_city).trim().length>120)return res.status(400).json({error:'City is too long'});if(body.supported_currency&&!/^[A-Z]{3}$/.test(String(body.supported_currency).toUpperCase()))return res.status(400).json({error:'Valid ISO currency required'});
 const payload={...body,country_code:country,market_city:MarketAvailabilityService.normalizeCity(body.market_city??body.marketCity),zone_id:MarketAvailabilityService.normalizeZone(body.zone_id??body.zoneId),updated_at:new Date().toISOString()};
 const{data,error}=await supabaseAdmin.from('market_availability').insert(payload).select('*').single();if(error)return res.status(409).json({error:error.message});res.status(201).json(data);});
router.put('/admin/:id',requireAdmin,async(req,res)=>{const{id,...unsafe}=req.body||{};if(unsafe.country_code&&!MarketAvailabilityService.normalizeCountry(unsafe.country_code))return res.status(400).json({error:'Valid ISO country required'});
 if(unsafe.market_city&&String(unsafe.market_city).trim().length>120)return res.status(400).json({error:'City is too long'});if(unsafe.supported_currency&&!/^[A-Z]{3}$/.test(String(unsafe.supported_currency).toUpperCase()))return res.status(400).json({error:'Valid ISO currency required'});
 const payload={...unsafe,updated_at:new Date().toISOString()};delete(payload as any).created_at;
 const{data,error}=await supabaseAdmin.from('market_availability').update(payload).eq('id',req.params.id).select('*').single();if(error)return res.status(400).json({error:error.message});res.json(data);});
export function sendMarketError(res:Response,error:unknown){if(error instanceof MarketAvailabilityError)return res.status(error.httpStatus).json({...publicShape(error.market,error.code),error:error.message});return null;}
export default router;

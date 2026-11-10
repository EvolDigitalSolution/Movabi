import {Router} from 'express';
import {rateLimit} from 'express-rate-limit';
import {supabaseAdmin} from '../services/supabase.service';
import {mapsV23,mapPoint} from '../services/maps-v23';
const router=Router();
router.use(async(req,res,next)=>{
 res.setHeader('Cache-Control','private, no-store');
 try{const header=String(req.headers.authorization||'');if(!/^Bearer\s+\S+$/i.test(header))return res.status(401).json({error:'Please sign in again.'});
 const {data,error}=await supabaseAdmin.auth.getUser(header.replace(/^Bearer\s+/i,''));if(error||!data?.user)return res.status(401).json({error:'Please sign in again.'});(req as any).mapsUserId=data.user.id;next();
 }catch{return res.status(503).json({error:'Map authentication unavailable.'});}
});
router.use(rateLimit({windowMs:60000,limit:60,keyGenerator:(req:any)=>req.mapsUserId,standardHeaders:true,legacyHeaders:false}));
router.get('/configuration',(_req,res)=>res.json(mapsV23.configuration()));
router.post('/:operation',async(req,res)=>{
 try{
  const op=req.params.operation,b=req.body||{};
  if(!['search','reverse','route'].includes(op))return res.status(404).json({error:'Map operation unavailable.'});
  if(op==='search'){
   const {data,error}=await supabaseAdmin.rpc('configured_payment_countries_v23');
   if(error||!Array.isArray(data))return res.status(503).json({error:'Country settings unavailable.'});
   const codes=[...new Set(data.map((c:any)=>String(c.country_code)))];
   if(!codes.length||codes.length>250||codes.some(c=>!/^[A-Z]{2}$/.test(c)))return res.status(503).json({error:'Country settings unavailable.'});
   if(b.global!==true&&!codes.includes(b.country))return res.status(400).json({error:'Choose a configured service country.'});
   return res.json(await mapsV23.search(b.query,b.global===true?codes.join(','):b.country,b.origin));
  }
  if(op==='reverse')return res.json(await mapsV23.reverse(mapPoint(b.point)));
  return res.json(await mapsV23.route(mapPoint(b.start),mapPoint(b.end)));
 }catch(e:any){const code=String(e?.message||'');return res.status(code.startsWith('INVALID_MAP_')?400:code.endsWith('_DISABLED')?404:503).json({error:'Map request could not be completed. Try again or choose a point on the map.'});}
});
export default router;

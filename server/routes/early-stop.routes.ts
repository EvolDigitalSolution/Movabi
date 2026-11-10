import earlyStopFareRoutes from './early-stop-fare.routes';
import {Router} from 'express';
import rateLimit from 'express-rate-limit';
import {supabaseAdmin} from '../services/supabase.service';
import {executeStopPilot,parseStopRequest,parseStopResponse,stopError} from '../services/early-stop-pilot.service';
const router=Router();
router.use(rateLimit({windowMs:60_000,limit:30,standardHeaders:true,legacyHeaders:false}));
router.use(async(req,res,next)=>{
  res.setHeader('Cache-Control','private, no-store');
  try {
    const header=String(req.headers.authorization||'');
    if(!/^Bearer\s+\S+$/i.test(header))return res.status(401).json({error:'Please sign in again.'});
    const {data,error}=await supabaseAdmin.auth.getUser(header.replace(/^Bearer\s+/i,''));
    if(error||!data.user)return res.status(401).json({error:'Please sign in again.'});
    if(process.env.VAYDU_EARLY_STOP_PILOT_V23!=='true'||process.env.NODE_ENV==='production')
      return res.status(404).json({error:'Early-stop confirmation is unavailable.'});
    res.locals.stopActor=data.user.id;next();
  } catch {return res.status(503).json({error:'Sign-in could not be checked. Please retry.'});}
});
router.use('/:jobId',(req,res,next)=>{
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(req.params.jobId)))
    return res.status(400).json({error:'A valid booking is required.'});
  next();
});
router.use('/:jobId/fare',earlyStopFareRoutes);
router.get('/:jobId',async(req,res)=>{
  try{return res.json(await executeStopPilot(supabaseAdmin,String(res.locals.stopActor),String(req.params.jobId),'read'));}
  catch(error){const result=stopError(error);return res.status(result.status).json(result);}
});
router.post('/:jobId/request',async(req,res)=>{
  try{const input=parseStopRequest(req.body);return res.json(await executeStopPilot(supabaseAdmin,String(res.locals.stopActor),String(req.params.jobId),'request',input));}
  catch(error){const result=stopError(error);return res.status(result.status).json(result);}
});
router.post('/:jobId/response',async(req,res)=>{
  try{const input=parseStopResponse(req.body);return res.json(await executeStopPilot(supabaseAdmin,String(res.locals.stopActor),String(req.params.jobId),input.action,input));}
  catch(error){const result=stopError(error);return res.status(result.status).json(result);}
});
export default router;

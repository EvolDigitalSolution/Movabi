import {previewEarlyStopReconciliation,reconciliationError} from '../services/early-stop-reconciliation.service';
import {closeEarlyStop,parseClosure,closureError} from '../services/early-stop-closure.service';
import {Router} from 'express';
import {supabaseAdmin} from '../services/supabase.service';
import {executeFarePilot,farePilotError,parseFareVote} from '../services/early-stop-fare.service';
const router=Router({mergeParams:true});
router.use((req,res,next)=>{
 res.setHeader('Cache-Control','private, no-store');
 if(!res.locals.stopActor)return res.status(401).json({error:'Please sign in again.'});
 if(process.env.VAYDU_EARLY_STOP_PILOT_V23!=='true'||process.env.VAYDU_EARLY_STOP_FARE_PILOT_V23!=='true'||process.env.NODE_ENV==='production')
  return res.status(404).json({error:'Fare proposals are unavailable.'});
 next();
});
router.use('/:stopId',(req,res,next)=>{
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(req.params.stopId)))return res.status(400).json({error:'A valid stop request is required.'});next();
});
router.get<{jobId:string;stopId:string}>('/:stopId',async(req,res)=>{
 try{return res.json(await executeFarePilot(supabaseAdmin,String(res.locals.stopActor),String(req.params.jobId),String(req.params.stopId),'read'));}
 catch(error){const result=farePilotError(error);return res.status(result.status).json(result);}
});
router.post<{jobId:string;stopId:string}>('/:stopId/proposal',async(req,res)=>{
 if(!req.body||typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(req.body).length)return res.status(400).json({error:'Fare and journey terms are calculated by the server.'});
 try{return res.json(await executeFarePilot(supabaseAdmin,String(res.locals.stopActor),String(req.params.jobId),String(req.params.stopId),'propose'));}
 catch(error){const result=farePilotError(error);return res.status(result.status).json(result);}
});
router.post<{jobId:string;stopId:string}>('/:stopId/response',async(req,res)=>{
 try{const vote=parseFareVote(req.body);return res.json(await executeFarePilot(supabaseAdmin,String(res.locals.stopActor),String(req.params.jobId),String(req.params.stopId),vote.action,vote));}
 catch(error){const result=farePilotError(error);return res.status(result.status).json(result);}
});

router.post<{jobId:string;stopId:string}>('/:stopId/close',async(req,res)=>{
 if(process.env.VAYDU_EARLY_STOP_CLOSURE_PILOT_V23!=='true')return res.status(404).json({error:'Early-stop closure is unavailable.'});
 try{const proposal=parseClosure(req.body);return res.json(await closeEarlyStop(supabaseAdmin,String(res.locals.stopActor),String(req.params.jobId),String(req.params.stopId),proposal));}
 catch(error){const result=closureError(error);return res.status(result.status).json(result);}
});

router.post<{jobId:string;stopId:string}>('/:stopId/reconciliation-plan',async(req,res)=>{
 if(process.env.VAYDU_EARLY_STOP_RECONCILIATION_V23!=='true')return res.status(404).json({error:'Reconciliation preview is unavailable.'});
 try{const proposal=parseClosure(req.body);return res.json(await previewEarlyStopReconciliation(supabaseAdmin,String(res.locals.stopActor),String(req.params.jobId),String(req.params.stopId),proposal));}
 catch{const result=reconciliationError();return res.status(result.status).json(result);}
});
export default router;

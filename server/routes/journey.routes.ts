import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../services/supabase.service';
import { ACTIVE_JOURNEY_STATUSES, issueJourneyGrant, verifyJourneyGrant, parseJourneyPoint } from '../services/journey-location.service';
const router = Router();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const key = () => process.env.MOVABI_JOURNEY_TOKEN_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
async function activeJob(jobId: string, driverId: string) {
  const {data,error} = await supabaseAdmin.from('jobs').select('id,driver_id,tenant_id,status').eq('id',jobId).eq('driver_id',driverId).maybeSingle();
  if(error) throw error;
  return data && data.tenant_id && ACTIVE_JOURNEY_STATUSES.has(String(data.status)) ? data : null;
}
router.post('/:jobId/session', async (req: Request,res: Response) => {
  try {
    const jobId=String(req.params.jobId); if(!uuid.test(jobId)) return res.status(400).json({error:'Invalid booking'});
    const bearer=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
    if(!bearer) return res.status(401).json({error:'Sign in required'});
    const {data,error}=await supabaseAdmin.auth.getUser(bearer);
    if(error || !data.user) return res.status(401).json({error:'Sign in required'});
    const job=await activeJob(jobId,data.user.id); if(!job) return res.status(403).json({error:'Active assigned booking required'});
    const expires=Date.now()+6*3600000;
    return res.json({token:issueJourneyGrant({jobId,driverId:data.user.id,tenantId:String(job.tenant_id),expires},key()),expires});
  } catch { return res.status(503).json({error:'Journey tracking temporarily unavailable'}); }
});
router.post('/:jobId/location', async (req: Request,res: Response) => {
  try {
    const jobId=String(req.params.jobId); if(!uuid.test(jobId)) return res.status(400).json({error:'Invalid booking'});
    const grant=verifyJourneyGrant(String(req.headers['x-movabi-journey-token']||''),key());
    if(!grant || grant.jobId!==jobId) return res.status(401).json({error:'Invalid journey session'});
    const point=parseJourneyPoint(req.body||{}); if(!point) return res.status(422).json({error:'Fresh accurate GPS location required'});
    const job=await activeJob(jobId,grant.driverId);
    if(!job || String(job.tenant_id)!==grant.tenantId) return res.status(403).json({error:'Journey has ended or assignment changed'});
    const {data:existing,error}=await supabaseAdmin.from('driver_locations').select('id,updated_at').eq('driver_id',grant.driverId).maybeSingle();
    if(error) throw error;
    if(existing?.updated_at && Date.parse(existing.updated_at)>=Date.parse(point.updated_at)) return res.json({accepted:false,reason:'older_point'});
    const payload={...point,driver_id:grant.driverId,tenant_id:grant.tenantId};
    let write;
    if(existing?.id) {
      let query=supabaseAdmin.from('driver_locations').update(payload).eq('id',existing.id);
      if(existing.updated_at) query=query.eq('updated_at',existing.updated_at);
      write=await query;
    } else { write=await supabaseAdmin.from('driver_locations').insert(payload); }
    if(write.error) throw write.error;
    return res.json({accepted:true});
  } catch { return res.status(503).json({error:'Location update temporarily unavailable'}); }
});
export default router;

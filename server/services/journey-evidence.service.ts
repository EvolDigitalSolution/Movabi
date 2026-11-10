import { parseJourneyPoint, type JourneyGrant } from './journey-location.service';
export type JourneyEvidenceResult = 'off'|'recorded'|'duplicate'|'out_of_order'|'throttled'|'limit_reached'|'unavailable';
/** Evidence collection is independent of billing and never blocks the live map. */
export async function recordJourneyEvidence(db:any, grant:JourneyGrant, body:Record<string,unknown>,
  enabled:boolean, now=Date.now()):Promise<JourneyEvidenceResult> {
  if(!enabled)return 'off';
  const point=parseJourneyPoint(body,now);
  if(!point)return 'unavailable';
  try {
    const {data,error}=await db.rpc('append_journey_evidence_v23',{
      p_job_id:grant.jobId,p_driver_id:grant.driverId,p_tenant_id:grant.tenantId,
      p_lat:point.lat,p_lng:point.lng,p_accuracy:body.accuracy,p_sampled_at:point.updated_at
    });
    const accepted=['recorded','duplicate','out_of_order','throttled','limit_reached'];
    return !error && typeof data==='string' && accepted.includes(data) ? data as JourneyEvidenceResult : 'unavailable';
  } catch { return 'unavailable'; }
}

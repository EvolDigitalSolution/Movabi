export const STOP_REASONS = ['breakdown','safety','medical','other'] as const;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function parseStopRequest(body:any):{requestId:string;reason:string;note:string} {
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['requestId','reason','note'].includes(k))||
    typeof body.requestId!=='string'||!uuid.test(body.requestId)||!STOP_REASONS.includes(body.reason)||
    (body.note!==undefined&&typeof body.note!=='string')||String(body.note||'').trim().length>1000)throw Error('STOP_INVALID_INPUT');
  return {requestId:body.requestId,reason:body.reason,note:String(body.note||'').trim()};
}
export function parseStopResponse(body:any):{requestId:string;action:'confirm'|'dispute';note:string} {
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['requestId','action','note'].includes(k))||
    typeof body.requestId!=='string'||!uuid.test(body.requestId)||!['confirm','dispute'].includes(body.action)||
    (body.note!==undefined&&typeof body.note!=='string')||String(body.note||'').trim().length>1000||
    (body.action==='dispute'&&String(body.note||'').trim().length<3)||
    (body.action==='confirm'&&String(body.note||'').trim()!==''))throw Error('STOP_INVALID_INPUT');
  return {requestId:body.requestId,action:body.action,note:String(body.note||'').trim()};
}
export async function executeStopPilot(db:any,actor:string,jobId:string,action:'read'|'request'|'confirm'|'dispute',input?:{requestId:string;reason?:string;note:string}) {
  const {data,error}=await db.rpc('journey_stop_pilot_v23',{p_actor:actor,p_job_id:jobId,p_action:action,
    p_request_id:input?.requestId||null,p_reason:input?.reason||null,p_note:input?.note||null});
  if(error)throw Error(/^STOP_[A-Z_]+$/.test(error.message||'')?error.message:'STOP_UNAVAILABLE');
  if(!data||data.enabled!==true||!['customer','driver'].includes(data.viewer)||data.bookingUpdated!==false||data.fareUpdated!==false)
    throw Error('STOP_UNAVAILABLE');
  return data;
}
export function stopError(error:unknown):{status:number;error:string;code:string} {
  const code=error instanceof Error?error.message:'STOP_UNAVAILABLE';
  const messages:Record<string,[number,string]>={
    STOP_INVALID_INPUT:[400,'Check your request details.'],STOP_NOT_PARTICIPANT:[403,'This booking is unavailable.'],
    STOP_NOT_ACTIVE_RIDE:[409,'Early-stop requests are available only during an active ride.'],
    STOP_REQUEST_EXISTS:[409,'A stop request already exists. Refresh to review it.'],
    STOP_REQUEST_MISMATCH:[409,'Refresh to load the current stop request.'],
    STOP_BOOKING_CHANGED:[409,'The booking changed. Contact support before continuing.'],
    STOP_REVIEW_REQUIRED:[409,'This stop request needs support review.'],
    STOP_CONFIRMATION_EXPIRED:[409,'The confirmation window expired. Contact support.']
  };
  const [status,message]=messages[code]||[503,'The stop request could not be confirmed. Refresh before retrying.'];
  return {status,error:message,code:messages[code]?code:'STOP_UNAVAILABLE'};
}

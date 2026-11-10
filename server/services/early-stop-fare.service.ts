import {calculateEarlyFare,FareEvidenceReview} from './early-stop-fare-calculator';
import {PaymentAuthorityService} from './payment-authority.service';
import {toCurrencyMinor} from '../../src/app/shared/utils/currency-money';
export function parseFareVote(body:any):{proposalId:string;action:'accept'|'reject';note:string}{
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['proposalId','action','note'].includes(k))||
  typeof body.proposalId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.proposalId)||
  !['accept','reject'].includes(body.action)||(body.note!==undefined&&typeof body.note!=='string'))throw Error('FARE_INVALID_INPUT');
 const note=String(body.note||'').trim();if(note.length>1000||(body.action==='reject'&&note.length<3)||(body.action==='accept'&&note))throw Error('FARE_INVALID_INPUT');
 return {proposalId:body.proposalId,action:body.action,note};
}
async function rpc(db:any,name:string,args:any){const {data,error}=await db.rpc(name,args);if(error)throw Error(/^FARE_[A-Z_]+$/.test(error.message||'')?error.message:'FARE_UNAVAILABLE');if(!data)throw Error('FARE_UNAVAILABLE');return data;}
export async function executeFarePilot(db:any,actor:string,jobId:string,stopId:string,action:'read'|'propose'|'accept'|'reject',vote?:{proposalId:string;note:string},authority=PaymentAuthorityService.resolve.bind(PaymentAuthorityService)){
 let digest:string|null=null,calculation:any=null;
 if(action==='propose'){
  const context=await rpc(db,'early_stop_fare_context_v23',{p_actor:actor,p_job_id:jobId,p_stop_id:stopId});
  calculation=calculateEarlyFare(context.frame);digest=context.digest;
  const payable=await authority(context.authorityJob);
  if(!payable||payable.currency.toUpperCase()!==calculation.currency||toCurrencyMinor(payable.serviceFareMajor,calculation.currency)!==calculation.originalMinor)
   throw new FareEvidenceReview('terms_changed');
 }
 const result=await rpc(db,'journey_fare_pilot_v23',{p_actor:actor,p_job_id:jobId,p_stop_id:stopId,p_action:action,
  p_source_digest:digest,p_calculation:calculation,p_proposal_id:vote?.proposalId||null,p_note:vote?.note||null});
 if(result.enabled!==true||result.bookingUpdated!==false||result.paymentUpdated!==false||!['customer','driver'].includes(result.viewer))throw Error('FARE_UNAVAILABLE');
 return result;
}
export function farePilotError(error:unknown){
 const code=error instanceof FareEvidenceReview?'FARE_EVIDENCE_REVIEW':error instanceof Error?error.message:'FARE_UNAVAILABLE';
 const codes:Record<string,[number,string]>={
  FARE_INVALID_INPUT:[400,'Check the fare response.'],FARE_NOT_PARTICIPANT:[403,'This booking is unavailable.'],
  FARE_NOT_ENROLLED:[409,'This ride is not enrolled for the fare proposal pilot. Support must review the fare.'],
  FARE_MISSING_START:[409,'A recorded trip start is missing. Support must review the fare.'],
  FARE_STOP_AGREEMENT_REQUIRED:[409,'Both parties must agree to stop before a fare can be proposed.'],
  FARE_BOOKING_CHANGED:[409,'The booking changed. Support must review the fare.'],
  FARE_SOURCE_CHANGED:[409,'The journey or booking evidence changed. Support must review the fare.'],
  FARE_PROPOSAL_EXISTS:[409,'A different proposal is already recorded. Refresh before continuing.'],
  FARE_PROPOSAL_MISMATCH:[409,'Refresh to load the current fare proposal.'],
  FARE_REVIEW_REQUIRED:[409,'The proposal was rejected. Contact support for review.'],
  FARE_EXPIRED:[409,'Fare confirmation expired. Contact support for review.'],
  FARE_EVIDENCE_REVIEW:[409,'Journey evidence or original pricing is incomplete or unreliable. Support must review the fare.']
 };
 const [status,message]=codes[code]||[503,'The fare proposal could not be confirmed. Refresh before retrying.'];
 return {status,error:message,code:codes[code]?code:'FARE_UNAVAILABLE'};
}

export function parseClosure(body:unknown):string{
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||!('proposalId' in body)
  ||typeof body.proposalId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.proposalId))throw Error('CLOSE_INVALID_INPUT');
 return body.proposalId;
}
export async function closeEarlyStop(db:any,actor:string,job:string,stop:string,proposal:string){
 const {data,error}=await db.rpc('close_early_stop_ngn_pilot_v23',{p_actor:actor,p_job:job,p_stop:stop,p_proposal:proposal});
 if(error)throw Error(/^CLOSE_[A-Z_]+$/.test(error.message||'')?error.message:'CLOSE_REVIEW_REQUIRED');
 if(!data||data.closed!==true||data.bookingId!==job||data.proposalId!==proposal||data.currency!=='NGN'
  ||data.paymentVerified!==false||data.driverPayoutEnabled!==false||data.sandbox!==true
  ||!Number.isSafeInteger(data.amountMinor)||data.amountMinor<10000)throw Error('CLOSE_UNCONFIRMED');
 return data;
}
export function closureError(error:unknown){
 const code=error instanceof Error?error.message:'';
 if(code==='CLOSE_INVALID_INPUT')return{status:400,code,error:'A valid fare proposal is required.'};
 if(code==='CLOSE_NOT_PARTICIPANT')return{status:403,code,error:'This booking is unavailable.'};
 if(['CLOSE_FARE_AGREEMENT_REQUIRED','CLOSE_SOURCE_CHANGED','CLOSE_ISOLATED_UNPAID_NGN_RIDE_REQUIRED','CLOSE_INVALID_TERMS','CLOSE_RECONCILIATION_REQUIRED','CLOSE_REVIEW_REQUIRED'].includes(code))return{status:409,code,error:'The ride could not be closed automatically. Support must review the fare and payment state.'};
 return{status:503,code:'CLOSE_UNCONFIRMED',error:'Closure is unconfirmed. Refresh and reconcile before retrying.'};
}

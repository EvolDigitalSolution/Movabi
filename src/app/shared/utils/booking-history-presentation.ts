export const endedBookingStatuses=new Set(['completed','settled','cancelled','canceled','failed','expired','no_driver_found','refunded']);
export function historyStatusLabel(status: string): string {
 const labels:Record<string,string>={completed:'Completed',settled:'Completed',cancelled:'Cancelled',canceled:'Cancelled',failed:'Failed',expired:'Expired',no_driver_found:'No driver found',refunded:'Refunded'};
 return labels[status] || 'In progress';
}
export function historyPaymentSummary(record: any): {label:string;detail:string;amount:number|null} {
 const status=String(record.paymentStatus || '').toLowerCase(), receipt=record.receipt || {};
 if(status==='refunded')return {label:'Refunded',detail:'The recorded payment has been refunded.',amount:null};
 if(['requires_refund','refund_pending'].includes(status))return {label:'Refund pending',detail:'Your refund is being processed. This record will update when confirmed.',amount:null};
 if(Number(record.refundedMinor)>0)return {label:'Partially refunded',detail:'Part of the captured payment has been returned.',amount:null};
 if(receipt.verified && receipt.status==='succeeded')return {label:'Paid',detail:'The captured payment is confirmed.',amount:Number(receipt.amount)};
 if(receipt.verified && receipt.status==='canceled')return {label:'Authorization released',detail:'The card authorization was cancelled. Bank processing times can vary.',amount:null};
 if(receipt.status==='requires_capture'||status==='authorized')return {label:'Authorized',detail:'Funds are reserved. This is not yet a completed charge.',amount:null};
 if(['paid','captured','succeeded'].includes(status))return {label:'Payment recorded',detail:record.paymentMethod==='wallet'?'Payment was settled from your wallet.':'Payment is recorded; the verified receipt total is temporarily unavailable.',amount:null};
 if(status==='wallet_funded')return {label:'Wallet funds reserved',detail:'Reserved funds are not yet a completed payment.',amount:null};
 if(status==='failed')return {label:'Payment failed',detail:'Payment was not confirmed. Contact support if you need help.',amount:null};
 return {label:'Payment pending',detail:'A completed payment has not been confirmed.',amount:null};
}
export function formatHistoryMoney(value: unknown,currency: string): string {
 if(value===null||value===undefined||!Number.isFinite(Number(value)))return 'Not available';
 try{return new Intl.NumberFormat('en-GB',{style:'currency',currency}).format(Number(value));}
 catch{return `${Number(value).toFixed(2)} ${currency}`;}
}

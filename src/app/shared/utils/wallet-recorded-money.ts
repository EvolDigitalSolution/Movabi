/** Recorded wallet currency only: no app-country preference, FX conversion or guessed GBP. */
export function recordedWalletAmount(value:unknown,currency:unknown,absolute=false):string {
 if(typeof currency!=='string'||!(/^[A-Z]{3}$/).test(currency))return 'Currency unavailable';
 const exponent=new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits!;
 let input:string;
 if(typeof value==='number'){
  if(!Number.isFinite(value))return 'Amount unavailable';
  const scaled=Math.abs(value)*10**exponent,minor=Math.round(scaled);
  if(!Number.isSafeInteger(minor)||Math.abs(scaled-minor)>0.000001)return 'Amount unavailable';
  input=(value<0&&!absolute?'-':'')+String(Math.floor(minor/10**exponent))+(exponent?'.'+String(minor%10**exponent).padStart(exponent,'0'):'');
 }else if(typeof value==='string')input=value;
 else return 'Amount unavailable';
 if(!/^-?(0|[1-9][0-9]{0,39})(\.[0-9]{1,40})?$/.test(input))return 'Amount unavailable';
 const negative=input.startsWith('-')&&!absolute;
 const [whole,fraction='']=input.replace(/^-/,'').split('.');
 if(/[1-9]/.test(fraction.slice(exponent)))return 'Amount unavailable';
 const decimals=fraction.slice(0,exponent).padEnd(exponent,'0');
 const nonzero=/[1-9]/.test(whole+decimals);
 return currency+' '+(negative&&nonzero?'-':'')+whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(exponent?'.'+decimals:'');
}
export function recordedWalletTransaction(tx:Record<string,unknown>,positive:boolean):string {
 const code=tx['currency_code'],alternative=tx['currency'];
 if(code!=null&&alternative!=null&&code!==alternative)return 'Currency unavailable';
 const amount=recordedWalletAmount(tx['amount'],code??alternative,true);
 return /unavailable$/.test(amount)?amount:(positive?'+':'−')+amount;
}

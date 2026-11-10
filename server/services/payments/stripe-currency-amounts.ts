import {providerCurrencyOption,STRIPE_ZERO_DECIMAL_CURRENCIES} from './provider-currency-options';
export type StripeMoneyOperation='charge'|'refund'|'payout';
export function stripeAmountRule(currency:string,operation:StripeMoneyOperation='charge'){
 if(!providerCurrencyOption('stripe',currency)||!['charge','refund','payout'].includes(operation))throw Error('STRIPE_CURRENCY_NOT_CONFIGURED');
 const wholeWithTwoApiDigits=currency==='ISK'||currency==='UGX'||(operation==='payout'&&['HUF','TWD'].includes(currency));
 const zero=(STRIPE_ZERO_DECIMAL_CURRENCIES as readonly string[]).includes(currency);
 return Object.freeze({currency,apiExponent:wholeWithTwoApiDigits?2:zero?0:2,allowedDecimalPlaces:wholeWithTwoApiDigits||zero?0:2});
}
/** Decimal text to provider API units. Never rounds an agreed fare or uses floats. */
export function stripeApiAmount(decimal:string,currency:string,operation:StripeMoneyOperation='charge'):number{
 const rule=stripeAmountRule(currency,operation);
 if(typeof decimal!=='string'||decimal.length>100||!/^(0|[1-9]\d*)(?:\.\d+)?$/.test(decimal))throw Error('INVALID_STRIPE_AMOUNT');
 const [whole,fraction='']=decimal.split('.');
 if(fraction.slice(rule.allowedDecimalPlaces).replace(/0/g,''))throw Error('STRIPE_AMOUNT_PRECISION_REQUIRES_REVIEW');
 const digits=fraction.slice(0,rule.apiExponent).padEnd(rule.apiExponent,'0');
 const amount=BigInt(whole)*10n**BigInt(rule.apiExponent)+BigInt(digits||'0');
 if(amount>BigInt(Number.MAX_SAFE_INTEGER))throw Error('UNSAFE_STRIPE_AMOUNT');
 return Number(amount);
}
/** Explicit boundary between stored ledger units and Stripe API units. */
export function stripeApiAmountFromLedger(minor:number,currency:string,ledgerExponent:number,operation:StripeMoneyOperation='charge'):number{
 if(!Number.isSafeInteger(minor)||minor<0||!Number.isInteger(ledgerExponent)||ledgerExponent<0||ledgerExponent>3)throw Error('INVALID_LEDGER_AMOUNT');
 const digits=String(minor).padStart(ledgerExponent+1,'0');
 const decimal=ledgerExponent?digits.slice(0,-ledgerExponent)+'.'+digits.slice(-ledgerExponent):digits;
 return stripeApiAmount(decimal,currency,operation);
}

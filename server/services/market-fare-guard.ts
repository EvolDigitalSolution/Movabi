/** A generic/foreign fare is not a market-specific price. This check precedes payment margin work. */
export function assertMarketFareConfigured(market:{countryCode?:string;currencyCode?:string},fare:{source:string;currencyCode:string}):void{
 const country=String(market.countryCode||'GB').toUpperCase(),currency=String(market.currencyCode||'').toUpperCase();
 if(country!=='GB'&&fare.source==='legacy_fallback')throw Object.assign(Error('Pricing is not available for this pickup area yet.'),{code:'MARKET_PRICING_NOT_CONFIGURED'});
 if(currency&&String(fare.currencyCode||'').toUpperCase()!==currency)throw Object.assign(Error('Pricing is not available for this pickup area yet.'),{code:'MARKET_PRICING_CURRENCY_MISMATCH'});
}

/** User-selected currency options reviewed 2026-10-23. Options are not live routes.
 * Stripe: https://docs.stripe.com/currencies
 * Kora: https://developers.korapay.com/docs/checkout-redirect and /docs/stablecoins
 */
export const STRIPE_REQUESTED_CURRENCIES=Object.freeze(["USD", "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT", "BIF", "BMD", "BND", "BOB", "BRL", "BSD", "BWP", "BYN", "BZD", "CAD", "CDF", "CHF", "CLP", "CNY", "COP", "CRC", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GIP", "GMD", "GNF", "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR", "ISK", "JMD", "JPY", "KES", "KGS", "KHR", "KMF", "KRW", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MUR", "MVR", "MWK", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SEK", "SGD", "SHP", "SLE", "SOS", "SRD", "STD", "SZL", "THB", "TJS", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX", "UYU", "UZS", "VND", "VUV", "WST", "XAF", "XCD", "XCG", "XOF", "XPF", "YER", "ZAR", "ZMW"] as const);
export const STRIPE_AMEX_EXCLUDED_CURRENCIES=Object.freeze(["AFN", "AOA", "ARS", "BOB", "BRL", "CLP", "COP", "CRC", "CVE", "DJF", "FKP", "GNF", "GTQ", "HNL", "LAK", "MUR", "NIO", "PAB", "PEN", "PYG", "SHP", "SRD", "STD", "UYU", "XOF", "XPF"] as const);
export const STRIPE_ZERO_DECIMAL_CURRENCIES=Object.freeze(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"] as const);
export const KORA_REQUESTED_FIAT_CURRENCIES=Object.freeze(["NGN", "KES", "GHS", "ZAR", "XOF", "XAF", "EGP", "TZS", "USD", "GBP"] as const);
export const KORA_REQUESTED_STABLECOINS=Object.freeze(['USDT','USDC'] as const);
export interface ProviderCurrencyOption {
 readonly provider:'stripe'|'kora'|'flutterwave'|'paystack';readonly currency:string;readonly product:'card_presentment'|'fiat_product_to_verify'|'stablecoin_wallet'|'collection_to_verify';
 readonly enabled:false;readonly merchantApprovalRequired:true;readonly installedAdapterRequired:true;
 readonly countryRequired:true;readonly networkRequired:boolean;readonly amexSupported:boolean|null;
}
const option=(provider:ProviderCurrencyOption['provider'],currency:string,product:ProviderCurrencyOption['product'],networkRequired:boolean,amexSupported:boolean|null):ProviderCurrencyOption=>
 Object.freeze({provider,currency,product,enabled:false,merchantApprovalRequired:true,installedAdapterRequired:true,countryRequired:true,networkRequired,amexSupported});
export const PROVIDER_CURRENCY_OPTIONS:readonly ProviderCurrencyOption[]=Object.freeze([
 ...['NGN','GHS','KES','ZAR','UGX','TZS','RWF','MWK','EGP','XAF','XOF','ZMW'].map(currency=>option('flutterwave',currency,'collection_to_verify',false,null)),
 ...['NGN'].map(currency=>option('paystack',currency,'collection_to_verify',false,null)),
 ...STRIPE_REQUESTED_CURRENCIES.map(currency=>option('stripe',currency,'card_presentment',false,!(STRIPE_AMEX_EXCLUDED_CURRENCIES as readonly string[]).includes(currency))),
 ...KORA_REQUESTED_FIAT_CURRENCIES.map(currency=>option('kora',currency,'fiat_product_to_verify',false,null)),
 ...KORA_REQUESTED_STABLECOINS.map(currency=>option('kora',currency,'stablecoin_wallet',true,null))
]);
export function providerCurrencyOption(provider:'stripe'|'kora'|'flutterwave'|'fincra'|'paystack',currency:string):ProviderCurrencyOption|null {
 return PROVIDER_CURRENCY_OPTIONS.find(option=>option.provider===provider&&option.currency===currency)??null;
}

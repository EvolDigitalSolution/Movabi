/** Planning markets only. Preference does not assert provider or merchant support.
 * Actual country, currency, method and merchant approvals require separate confirmation. */
export const AFRICAN_PAYMENT_CANDIDATES=Object.freeze([
 ['NG','NGN'],['GH','GHS'],['KE','KES'],['ZA','ZAR'],['UG','UGX'],['TZ','TZS'],['RW','RWF'],['MW','MWK'],['EG','EGP'],
 // XAF/XOF support is country-specific. These candidates require individual confirmation.
 ['CM','XAF'],['CI','XOF'],['SN','XOF'],['ZM','ZMW']
].map(([country,currency])=>Object.freeze({country,currency,preferredProvider:'flutterwave' as const,candidateProviders:Object.freeze(['flutterwave','kora','fincra'] as const),enabled:false})));
export const STRIPE_PAYMENT_CANDIDATES=Object.freeze([
 ['AU','AUD'],['AT','EUR'],['BE','EUR'],['BR','BRL'],['BG','EUR'],['CA','CAD'],['HR','EUR'],['CY','EUR'],['CZ','CZK'],
 ['DK','DKK'],['EE','EUR'],['FI','EUR'],['FR','EUR'],['DE','EUR'],['GI','GBP'],['GR','EUR'],['HK','HKD'],['HU','HUF'],
 ['IE','EUR'],['IT','EUR'],['JP','JPY'],['LV','EUR'],['LI','CHF'],['LT','EUR'],['LU','EUR'],['MY','MYR'],['MT','EUR'],
 ['MX','MXN'],['NL','EUR'],['NZ','NZD'],['NO','NOK'],['PL','PLN'],['PT','EUR'],['RO','RON'],['SG','SGD'],['SK','EUR'],
 ['SI','EUR'],['ES','EUR'],['SE','SEK'],['CH','CHF'],['TH','THB'],['AE','AED'],['GB','GBP'],['US','USD']
].map(([country,currency])=>Object.freeze({country,currency,preferredProvider:'stripe' as const,enabled:false})));

// Currency options are separate from market/account approvals and enabled routes.
export {PROVIDER_CURRENCY_OPTIONS,STRIPE_REQUESTED_CURRENCIES,KORA_REQUESTED_FIAT_CURRENCIES,KORA_REQUESTED_STABLECOINS,providerCurrencyOption} from './provider-currency-options';
export {stripeApiAmount,stripeApiAmountFromLedger,stripeAmountRule} from './stripe-currency-amounts';

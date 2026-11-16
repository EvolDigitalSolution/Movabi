/** Account context only. Booking/payment market comes from the server's service-market quote. */
export function profileRegistrationCountry(profile: {registration_country_code?:string|null;country_code?:string|null}):string|null {
 const country=String(profile.registration_country_code?.trim() || profile.country_code?.trim() || '').toUpperCase();
 return /^[A-Z]{2}$/.test(country)?country:null;
}
export function savedProfileCurrency(profile:{currency_code?:string|null}):string|null {
 const currency=String(profile.currency_code||'').trim().toUpperCase();
 return /^[A-Z]{3}$/.test(currency)?currency:null;
}

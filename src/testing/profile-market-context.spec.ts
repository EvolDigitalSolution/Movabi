import {describe,it,expect} from 'vitest';
import {profileRegistrationCountry,savedProfileCurrency} from '../app/shared/utils/profile-market-context';
describe('account context stays separate from authoritative booking/payment market',()=>{
 it.each([['GB','GBP'],['NG','NGN'],['NG','GBP']])('displays persisted %s/%s without silently converting it',(c,k)=>{
  const p={registration_country_code:c,country_code:'GB',currency_code:k};
  expect(profileRegistrationCountry(p)).toBe(c);expect(savedProfileCurrency(p)).toBe(k);expect(p.currency_code).toBe(k);
 });
 it.each([null,'','  '])('blank legacy registration %j falls back to saved country',registration=>{
  expect(profileRegistrationCountry({registration_country_code:registration,country_code:' ng '})).toBe('NG');
 });
 it('missing fields stay unresolved, rather than inventing GB/GBP',()=>{
  expect(profileRegistrationCountry({})).toBeNull();expect(savedProfileCurrency({currency_code:' '})).toBeNull();
 });
});

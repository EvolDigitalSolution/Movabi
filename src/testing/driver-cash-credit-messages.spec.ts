import { describe, expect, it } from 'vitest';
import { cashCreditStatusMessage, topupAvailabilityMessage, type DriverCashCreditStatus } from '../app/shared/utils/driver-cash-credit';

// Cash-ride state and top-up availability are separate server decisions. The cash-ride message
// must never claim "Top-ups are unavailable"; that comes only from the top-up service.
const base=(over:Partial<DriverCashCreditStatus>={}):DriverCashCreditStatus=>({driverId:'d',tenantId:'t',country:'GB',currency:'GBP',pilotEnabled:false,enrolled:false,
  balance:{currency:'GBP',consistent:true,availableMinor:'1100',heldMinor:'0',deficitMinor:'0',eligibleDepositsMinor:'1100'},
  topupAvailable:false,payoutAvailable:false,acceptanceAuthority:'database',...over} as DriverCashCreditStatus);

describe('cash-ride status message',()=>{
  it.each([
    [base(),'Cash rides are not enabled in GB yet. Your credit is kept for when they are.'],
    [base({pilotEnabled:true}),'Cash rides are not approved for this account in GB yet. Your credit is kept.'],
    [base({pilotEnabled:true,enrolled:true}),'Cash rides are enabled for you in GB. Credit is checked for each ride.'],
    [base({country:'NG',currency:'NGN',pilotEnabled:true,enrolled:true}),'Cash rides are enabled for you in NG. Credit is checked for each ride.'],
    [base({pilotEnabled:true,enrolled:true,balance:{currency:'GBP',consistent:false,availableMinor:'0',heldMinor:'0',deficitMinor:'0',eligibleDepositsMinor:'0'}}),'Cash credit needs review before another cash ride.'],
  ])('%#',(s,text)=>{
    expect(cashCreditStatusMessage(s)).toBe(text);
    expect(cashCreditStatusMessage(s)).not.toMatch(/top-?up/i);
  });
});

describe('top-up availability message (from the top-up service only)',()=>{
  it('reflects the server decision',()=>{
    expect(topupAvailabilityMessage('available')).toBe('');
    expect(topupAvailabilityMessage('unavailable')).toBe('Top-ups are unavailable right now.');
    expect(topupAvailabilityMessage('checking')).toBe('Checking top-up availability…');
  });
});

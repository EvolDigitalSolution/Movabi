import {describe, it} from 'vitest';
import assert from 'node:assert/strict';
import {earningsSummary, recordedEarningAmount, recordedFeeAmount, recordedGrossAmount, recordedPayoutLabel} from '../app/shared/utils/earnings-currency';
const clean = (text: string) => text.replace(/\s/g, ' ');
describe('recorded earnings currencies', () => {
  it('preserves the observed GBP balances even for a Nigeria profile', () => {
    const rows = [{currency_code:'GBP', status:'paid', amount:'59.46'}, {currency_code:'GBP', status:'pending', amount:'15.97'}];
    assert.equal(clean(earningsSummary(rows,'paid')), 'GBP 59.46');
    assert.equal(clean(earningsSummary(rows,'pending')), 'GBP 15.97');
  });
  it('never adds GBP and NGN amounts together', () => {
    assert.equal(clean(earningsSummary([{currency_code:'NGN',status:'paid',amount:100},{currency_code:'GBP',status:'paid',amount:2}],'paid')), 'GBP 2.00 · NGN 100.00');
  });
  it('adds decimal amounts without binary rounding drift', () => {
    assert.equal(clean(earningsSummary([{currency_code:'GBP',status:'paid',amount:0.1},{currency_code:'GBP',status:'paid',amount:0.2}],'paid')), 'GBP 0.30');
  });
  it('retains recorded zero and negative adjustments', () => {
    assert.equal(clean(recordedEarningAmount({currency_code:'GBP',amount:0})), 'GBP 0.00');
    assert.equal(clean(recordedEarningAmount({currency_code:'GBP',amount:-1.25})), '-GBP 1.25');
  });
  it('does not invent currency for legacy rows', () => {
    assert.equal(recordedEarningAmount({amount:59.46}), 'Currency unavailable');
    assert.equal(earningsSummary([{amount:59.46,status:'paid'}],'paid'), 'Currency unavailable (1 records)');
  });
  it('does not report a partial sum when a record amount is malformed', () => {
    assert.equal(earningsSummary([{currency_code:'GBP',status:'paid',amount:2},{currency_code:'GBP',status:'paid',amount:null}],'paid'), 'GBP amount unavailable');
  });
  it('rejects nonfinite and excessive-precision money', () => {
    for (const amount of [NaN, Infinity, '1e3','1.234', '9007199254740992']) assert.equal(recordedEarningAmount({currency_code:'GBP',amount}), 'GBP amount unavailable');
  });
  it('honours zero-decimal and three-decimal currency units', () => {
    assert.equal(clean(recordedEarningAmount({currency_code:'JPY',amount:123})), 'JPY 123');
    assert.equal(clean(recordedEarningAmount({currency_code:'KWD',amount:'1.234'})), 'KWD 1.234');
  });
  it('does not count a failed payout as paid or pending', () => {
    const rows=[{currency_code:'GBP',status:'failed',amount:9}];
    assert.equal(clean(earningsSummary(rows,'paid')), 'GBP 0.00');
    assert.equal(clean(earningsSummary(rows,'pending')), 'GBP 0.00');
    assert.equal(clean(earningsSummary(rows,'failed')), 'GBP 9.00');
  });
  it('keeps unknown payout status explicit', () => assert.equal(recordedPayoutLabel({status:'unknown'}), 'Payout needs reconciliation'));
  it('does not infer a Stripe transfer from paid status', () => assert.equal(recordedPayoutLabel({status:'paid'}), 'Paid (recorded)'));
  it('identifies actual Stripe transfer evidence without claiming bank settlement', () => assert.equal(recordedPayoutLabel({status:'paid',stripe_transfer_id:'tr_example'}), 'Transferred to Stripe account'));
  it('keeps a failed status visible even if a transfer reference exists', () => assert.equal(recordedPayoutLabel({status:'failed',stripe_transfer_id:'tr_example'}), 'Payout failed'));
  it('uses recorded gross minus net for deductions with exact pennies', () => {
    assert.equal(clean(earningsSummary([{currency_code:'GBP',gross_amount:'10.00',amount:'8.10',platform_fee:'1.00'}],'fees')), 'GBP 1.90');
  });
  it('does not turn a missing fee into a recorded zero', () => {
    assert.equal(earningsSummary([{currency_code:'GBP',amount:2}],'fees'), 'GBP amount unavailable');
    assert.equal(clean(earningsSummary([{currency_code:'GBP',amount:2,platform_fee:0}],'fees')), 'GBP 0.00');
  });
  it('does not invent missing row deductions or gross earnings', () => {
    assert.equal(recordedFeeAmount({currency_code:'GBP',amount:2}), 'GBP amount unavailable');
    assert.equal(recordedGrossAmount({currency_code:'GBP',amount:2}), 'GBP amount unavailable');
    assert.equal(clean(recordedGrossAmount({currency_code:'GBP',amount:2,platform_fee:0})), 'GBP 2.00');
  });
  it('does not mutate financial records' , () => {
    const rows=[{currency_code:'GBP',status:'paid',amount:'1.23'}]; const before=JSON.stringify(rows);
    earningsSummary(rows,'paid'); recordedEarningAmount(rows[0]); recordedPayoutLabel(rows[0]); assert.equal(JSON.stringify(rows),before);
  });
});

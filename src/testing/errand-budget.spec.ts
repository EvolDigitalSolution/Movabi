import { describe, it, expect } from 'vitest';
import { approvedErrandBudget } from '../app/shared/utils/errand-budget';
describe('approved shopping budgets', () => {
  it('keeps a pending increase unavailable', () => {
    expect(approvedErrandBudget({ item_budget: 30, over_budget_status: 'requested', requested_over_budget_amount: 40 }, 30)).toBe(30);
  });
  it('uses the approved total without adding it to the original', () => {
    expect(approvedErrandBudget({ item_budget: 40, over_budget_status: 'approved', requested_over_budget_amount: 40, over_budget_amount: 10 }, 30)).toBe(40);
  });
  it('uses the current budget after a rejection of a subsequent request', () => {
    expect(approvedErrandBudget({ item_budget: 40, over_budget_status: 'rejected', requested_over_budget_amount: 0 }, 30)).toBe(40);
  });
  it('supports legacy extra-only approved rows', () => {
    expect(approvedErrandBudget({ over_budget_status: 'approved', over_budget_amount: 10 }, 30)).toBe(40);
  });
  it('does not mistake the service-plus-budget reservation for shopping money', () => {
    expect(approvedErrandBudget({ amount_reserved: 50, item_budget: 30 }, 30)).toBe(30);
  });
});

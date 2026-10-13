import { describe, expect, it } from 'vitest';
import { shoppingCardBalance } from '../app/shared/utils/shopping-card-balance';
describe('shopping card available balance', () => {
 const verified = (amount: number, pending = false) => ({ shopping_spend_source: 'issuing', shopping_spend_amount: amount, shopping_spend_pending: pending });
 it('shows no available budget after spending GBP60 of GBP60', () => expect(shoppingCardBalance(60, verified(60)).available).toBe(0));
 it('shows the unused budget after partial spending', () => expect(shoppingCardBalance(60, verified(42.5))).toEqual({ spent: 42.5, pending: false, available: 17.5 }));
 it('does not turn a manual entry into a verified card purchase', () => expect(shoppingCardBalance(60, { actual_spending: 60 }).spent).toBeNull());
 it('does not advertise available funds while holds remain pending', () => expect(shoppingCardBalance(60, verified(20, true)).available).toBeNull());
 it('does not show a negative available balance', () => expect(shoppingCardBalance(60, verified(70)).available).toBe(0));
});

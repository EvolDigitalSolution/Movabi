/** requested_over_budget_amount is the requested TOTAL, not the extra amount. */
export function approvedErrandBudget(funding: unknown, originalBudget: unknown = 0): number {
  const row = funding && typeof funding === 'object' ? funding as Record<string, unknown> : {};
  const metadata = row['metadata'] && typeof row['metadata'] === 'object'
    ? row['metadata'] as Record<string, unknown> : {};
  const money = (value: unknown): number => {
    const amount = Number(value);
    return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : 0;
  };
  const initial = money(originalBudget);
  const current = money(row['item_budget']) || money(metadata['item_budget']);
  if (row['over_budget_status'] === 'approved') {
    return money(row['requested_over_budget_amount']) || current
      || money(initial + money(row['over_budget_amount']));
  }
  return current || initial;
}

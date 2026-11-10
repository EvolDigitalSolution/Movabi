export function shoppingCardBalance(budget: number, metadata: Record<string, unknown> | null | undefined) {
    const value = metadata?.['shopping_spend_amount'];
    const spent = Number(value);
    const verified = metadata?.['shopping_spend_source'] === 'issuing' && value != null && Number.isFinite(spent) && spent >= 0;
    const pending = metadata?.['shopping_spend_pending'] === true;
    return { spent: verified ? spent : null, pending,
        available: verified && !pending ? Math.max(0, budget - spent) : null };
}

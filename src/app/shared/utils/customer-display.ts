export function customerDisplayName(profile: Record<string, unknown> | null | undefined): string {
    const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
    return text(profile?.['full_name']) || text(profile?.['display_name']) || text(profile?.['name']) ||
        [text(profile?.['first_name']), text(profile?.['last_name'])].filter(Boolean).join(' ') || 'Customer';
}

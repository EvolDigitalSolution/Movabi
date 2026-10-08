export function adminMessageRoute(id: unknown): string | null {
    const value = String(id || '');
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
        ? `/account/messages?messageId=${encodeURIComponent(value)}` : null;
}

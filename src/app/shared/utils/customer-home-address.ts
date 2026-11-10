/** Existing profile columns; home_address holds the complete multiline address. */
export function savedCustomerAddress(profile: {home_address?: unknown; address_line1?: unknown; current_address?: unknown} | null | undefined): string {
    for (const value of [profile?.home_address,profile?.address_line1,profile?.current_address]) {
        const text = typeof value === 'string' ? value.trim() : '';
        if (text) return text;
    }
    return '';
}
export function customerAddressUpdate(value: unknown): {home_address: string; address_line1: string} {
    const address = String(value ?? '').replace(/\r\n?/g,'\n').trim();
    if (!address || address.length > 600) throw Error('Enter a home address using no more than 600 characters.');
    const firstLine = address.split('\n').find(line => line.trim())!.trim();
    if (firstLine.length > 250) throw Error('Keep the first address line within 250 characters.');
    return {home_address:address,address_line1:firstLine};
}

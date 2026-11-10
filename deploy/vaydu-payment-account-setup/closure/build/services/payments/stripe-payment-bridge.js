"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SHARED_PAYMENT_LAYER_VERSION = void 0;
exports.createStripePaymentBridge = createStripePaymentBridge;
exports.SHARED_PAYMENT_LAYER_VERSION = '2.3.0';
const operations = Object.freeze({
    paymentIntents: Object.freeze(['create', 'retrieve', 'capture', 'cancel', 'list']),
    refunds: Object.freeze(['create', 'retrieve', 'list']),
    transfers: Object.freeze(['create', 'retrieve', 'list', 'createReversal']),
    charges: Object.freeze(['retrieve', 'list'])
});
/** Compatibility lane for already persisted Stripe bookings.
 * No normalization, validation changes, new retries or provider selection here.
 * Preserve the original SDK promise (including list pagination) and request arguments.
 */
function createStripePaymentBridge(client, enabled = false) {
    if (!enabled)
        return client;
    const resources = new Map();
    return new Proxy(client, {
        get(target, property) {
            const original = Reflect.get(target, property, target);
            if (typeof property !== 'string' || !Object.prototype.hasOwnProperty.call(operations, property) || !original)
                return original;
            if (typeof original !== 'object' && typeof original !== 'function')
                return original;
            if (resources.has(property))
                return resources.get(property);
            const functions = new Map();
            const resource = new Proxy(original, {
                get(resourceTarget, method) {
                    const member = Reflect.get(resourceTarget, method, resourceTarget);
                    if (typeof member !== 'function')
                        return member;
                    if (functions.has(method))
                        return functions.get(method);
                    const invoke = function (...args) { return Reflect.apply(member, resourceTarget, args); };
                    // All functions on these resources keep their original SDK receiver, including
                    // future SDK methods. They never invoke another payment provider.
                    functions.set(method, invoke);
                    return invoke;
                }
            });
            resources.set(property, resource);
            return resource;
        }
    });
}

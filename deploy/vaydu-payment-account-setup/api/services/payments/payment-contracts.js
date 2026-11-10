"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PaymentLayerError = void 0;
exports.requiredText = requiredText;
exports.positiveMinor = positiveMinor;
exports.validateRoute = validateRoute;
exports.bindPayment = bindPayment;
exports.assertOriginalRoute = assertOriginalRoute;
class PaymentLayerError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'PaymentLayerError';
    }
}
exports.PaymentLayerError = PaymentLayerError;
function requiredText(value, label) {
    if (typeof value !== 'string' || !value.trim() || value !== value.trim())
        throw new PaymentLayerError('INVALID_PAYMENT_INPUT', label + ' is required');
    return value;
}
function positiveMinor(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
        throw new PaymentLayerError('INVALID_PAYMENT_AMOUNT', 'A positive safe integer in currency minor units is required');
    return value;
}
function validateRoute(route) {
    if (!route || !['stripe', 'kora', 'fincra', 'flutterwave', 'paystack'].includes(route.provider))
        throw new PaymentLayerError('INVALID_PAYMENT_PROVIDER', 'Unknown payment provider');
    requiredText(route.merchantAccountRef, 'Merchant account');
    if (!/^[A-Z]{2}$/.test(route.country) || !/^[A-Z]{3}$/.test(route.currency))
        throw new PaymentLayerError('INVALID_PAYMENT_MARKET', 'Explicit country and currency are required');
}
function bindPayment(route, reference) {
    validateRoute(route);
    requiredText(reference, 'Payment reference');
    return Object.freeze({ provider: route.provider, merchantAccountRef: route.merchantAccountRef, country: route.country, currency: route.currency, paymentReference: reference });
}
function assertOriginalRoute(binding, route) {
    validateRoute(binding);
    validateRoute(route);
    requiredText(binding.paymentReference, 'Original payment reference');
    if (binding.provider !== route.provider || binding.merchantAccountRef !== route.merchantAccountRef || binding.country !== route.country || binding.currency !== route.currency)
        throw new PaymentLayerError('PAYMENT_ROUTE_MISMATCH', 'Use the original provider, account, country and currency');
}

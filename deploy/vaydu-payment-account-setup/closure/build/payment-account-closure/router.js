"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.driverPaymentAccountRouter = driverPaymentAccountRouter;
const express_1 = require("express");
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const service_1 = require("./service");
/**
 * Setup-only payment-account surface. The baseline's supabaseAdmin is injected
 * explicitly by the mount; this module never imports the local supabase service.
 * No payout worker, transfer, collection or subaccount code is reachable here.
 */
function driverPaymentAccountRouter(db, provider, requestLimit = 20) {
    const service = new service_1.SetupService(db, provider);
    const router = (0, express_1.Router)();
    router.use((0, express_rate_limit_1.default)({ windowMs: 60000, max: requestLimit, standardHeaders: true, legacyHeaders: false,
        message: { error: 'Please wait before retrying payment account setup.' } }));
    router.use(async (req, res, next) => {
        try {
            const token = /^Bearer (\S+)$/.exec(req.headers.authorization || '')?.[1];
            if (!token)
                return void res.status(401).json({ error: 'Sign in required.' });
            const result = await db.auth.getUser(token);
            if (result.error || !result.data?.user)
                return void res.status(401).json({ error: 'Sign in required.' });
            res.locals.driverId = result.data.user.id;
            next();
        }
        catch {
            res.status(401).json({ error: 'Sign in required.' });
        }
    });
    const handler = (fn) => async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        try {
            res.json(await fn(req, res.locals.driverId));
        }
        catch (error) {
            res.status(409).json({ error: 'Payment account request could not be verified. Refresh or contact support.', errorCode: 'PAYMENT_ACCOUNT_SETUP_FAILED' });
        }
    };
    router.get('/status', handler((_, id) => service.status(id)));
    router.get('/banks', handler(async (_, id) => ({ banks: await service.banks(id) })));
    router.post('/resolve', handler(async (req, id) => ({
        accountName: await service.resolve(id, String(req.body?.bankCode || ''), String(req.body?.accountNumber || '')),
    })));
    router.post('/setup', handler((req, id) => req.body?.confirmed === true
        ? service.setup(id, String(req.body?.bankCode || ''), String(req.body?.accountNumber || ''), String(req.body?.accountName || ''))
        : Promise.reject(new Error('Confirmation required.'))));
    // Read-only reconciliation surface: an ambiguous provider creation is never
    // retried automatically; the operator decides on a reviewed recovery.
    router.post('/reconcile', handler((_, id) => service.reconcile(id)));
    return router;
}

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSupabaseAuthRegistrationClient = exports.supabaseAdmin = exports.getSupabaseAdmin = void 0;
exports.resolveExternalSupabaseUrl = resolveExternalSupabaseUrl;
const supabase_js_1 = require("@supabase/supabase-js");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
let _supabaseAdmin = null;
const getSupabaseAdmin = () => {
    if (!_supabaseAdmin) {
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!supabaseUrl || !supabaseServiceKey) {
            throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in environment variables.');
        }
        _supabaseAdmin = (0, supabase_js_1.createClient)(supabaseUrl, supabaseServiceKey, {
            auth: {
                autoRefreshToken: false,
                persistSession: false
            }
        });
    }
    return _supabaseAdmin;
};
exports.getSupabaseAdmin = getSupabaseAdmin;
// For backward compatibility, export a proxy that lazily initializes the client
exports.supabaseAdmin = new Proxy({}, {
    get: (target, prop) => {
        const client = (0, exports.getSupabaseAdmin)();
        const value = client[prop];
        if (typeof value === 'function') {
            return value.bind(client);
        }
        return value;
    }
});
/**
 * Resolve the EXTERNALLY reachable Supabase base URL used ONLY for the
 * server-side registration `auth.signUp()` request, so email-confirmation links
 * use a public hostname instead of the private Kong hostname.
 *
 * Precedence:
 *   1. API_EXTERNAL_URL  (explicit public Supabase endpoint)
 *   2. MOVABI_SUPABASE_DOMAIN  (public Supabase domain, converted to https)
 *   3. SUPABASE_URL  (only in non-production, where it is the public URL)
 *
 * In production, if no external URL is available this THROWS rather than
 * silently emitting confirmation links with the private Kong hostname.
 */
function resolveExternalSupabaseUrl(env = process.env) {
    const explicit = env.API_EXTERNAL_URL;
    if (explicit && /^https?:\/\//i.test(explicit))
        return explicit;
    const domain = env.MOVABI_SUPABASE_DOMAIN;
    if (domain) {
        const host = String(domain).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
        if (host)
            return `https://${host}`;
    }
    if (env.NODE_ENV !== 'production') {
        const url = env.SUPABASE_URL;
        if (url)
            return url;
    }
    throw new Error('API_EXTERNAL_URL (or MOVABI_SUPABASE_DOMAIN) is required to generate external confirmation links.');
}
let _authRegistrationClient = null;
/**
 * Narrowly scoped Supabase Auth client for the server-side registration
 * signUp() call. It targets the externally reachable Supabase endpoint while
 * the normal `supabaseAdmin` continues to use the internal SUPABASE_URL for
 * ordinary DB/service operations.
 */
const getSupabaseAuthRegistrationClient = () => {
    if (!_authRegistrationClient) {
        const supabaseUrl = resolveExternalSupabaseUrl();
        const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!supabaseServiceKey) {
            throw new Error('SUPABASE_SERVICE_ROLE_KEY is required in environment variables.');
        }
        _authRegistrationClient = (0, supabase_js_1.createClient)(supabaseUrl, supabaseServiceKey, {
            auth: {
                autoRefreshToken: false,
                persistSession: false
            }
        });
    }
    return _authRegistrationClient;
};
exports.getSupabaseAuthRegistrationClient = getSupabaseAuthRegistrationClient;

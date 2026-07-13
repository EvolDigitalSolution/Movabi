import express, { Request, Response, NextFunction } from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import { rateLimit } from 'express-rate-limit';

// Load environment variables first (only for local development)
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

// Check for critical environment variables before loading any modules
const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  console.error('==========================================');
  console.error('FATAL: Missing required environment variables');
  console.error('==========================================');
  console.error('The following environment variables are required:');
  missingVars.forEach(varName => {
    console.error(`  - ${varName}`);
  });
  console.error('==========================================');
  console.error('Please set these environment variables and restart the server.');
  console.error('==========================================');
  process.exit(1);
}
import subscriptionRoutes from './routes/subscription.routes';
import logisticsRoutes from './routes/logistics.routes';
import connectRoutes from './routes/connect.routes';
import paymentRoutes from './routes/payment.routes';
import bookingRoutes from './routes/booking.routes';
import walletRoutes from './routes/wallet.routes';
import adminRoutes from './routes/admin.routes';
import appRoutes from './routes/app.routes';
import webhookRoutes from './routes/webhook.routes';
import stripeWebhookRoutes from './routes/stripe-webhook.routes';
import communicationRoutes from './routes/communication.routes';
import issuingRoutes from './routes/issuing.routes';
import verificationRoutes from './routes/verification.routes';
import globalAiPricingRoutes from './routes/global-ai-pricing.routes';
import marketplaceRoutes from './routes/marketplace.routes';
import { dispatchService } from './services/dispatch.service';
import { marketplaceCleanupService } from './services/marketplace-cleanup.service';

import { HealthService } from './services/health.service';

const app = express();

app.use((req: any, res: any, next: any) => {
  const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:8100',
    'https://localhost',
    'capacitor://localhost',
    'ionic://localhost',
    'https://movabi.apps.evolsolution.com',
    'https://admin.movabi.apps.evolsolution.com',
    'https://movabi-api.apps.evolsolution.com'
  ];

  const origin = req.headers.origin;

  if (origin && allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  } else if (origin) {
    console.warn('[CORS] blocked origin', origin);
  }

  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Authorization,Content-Type,Accept,Origin,X-Requested-With,apikey,x-client-info');

  if (req.method === 'OPTIONS') {
    return res.status(204).send();
  }

  next();
});

const PORT = Number(process.env['PORT'] || 3001);
app.set('trust proxy', 1);

// Failsafe middleware
const failsafeGuard = (req: Request, res: Response, next: NextFunction) => {
  if (HealthService.isSystemDegraded() && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    // Allow webhooks and admin actions even if degraded (for recovery)
    if (req.path.startsWith('/api/webhook') || req.path.startsWith('/api/admin')) {
      return next();
    }
    return res.status(503).json({
      error: 'System is currently in read-only mode due to service degradation.',
      status: HealthService.getStatus()
    });
  }
  next();
};

// Rate limiting
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests from this IP, please try again after 15 minutes' }
});

const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts, please try again after an hour' }
});

const bookingLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 5,
  message: { error: 'Booking rate limit exceeded. Please wait a minute.' }
});

// CORS configuration
//
// 🔥 CRITICAL for your error
// Apply guards
app.use(failsafeGuard);
app.use('/api/', globalLimiter);
app.use('/api/booking/create', bookingLimiter);

// Stripe webhook needs raw body for signature verification
app.use('/api/subscriptions/webhook', bodyParser.raw({ type: 'application/json' }));
app.use('/api/webhook/stripe', bodyParser.raw({ type: 'application/json' }), stripeWebhookRoutes);

// Other routes use JSON body
app.use(bodyParser.json());

// Routes
app.use('/api/app', appRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/logistics', logisticsRoutes);
app.use('/api/connect', connectRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/booking', bookingRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/communication', communicationRoutes);
app.use('/api/issuing', issuingRoutes);
app.use('/api/verification', verificationRoutes);
app.use('/api/marketplace', marketplaceRoutes);
app.use('/api/pricing/global-ai', globalAiPricingRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/stripe/connect', connectRoutes);
app.use('/api/connect', connectRoutes);
app.use('/api/webhook', webhookRoutes);

// Start Background Jobs
setInterval(() => {
  dispatchService.runDispatchEngine();
}, 10000);

marketplaceCleanupService.start();

setInterval(() => {
  HealthService.checkHealth();
}, 60000); // Check health every minute

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// Error handling middleware
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Graceful startup with error handling
try {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    
    // Check for critical missing environment variables
    const requiredEnvVars = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
    const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
    
    if (missingVars.length > 0) {
      console.error(`[CRITICAL] Missing required environment variables: ${missingVars.join(', ')}`);
      console.error('[CRITICAL] Server started in degraded mode. Some features may not work correctly.');
      console.error('[CRITICAL] Please set the following environment variables and restart:');
      missingVars.forEach(varName => {
        console.error(`[CRITICAL] - ${varName}`);
      });
    }
    
    // Check for optional but recommended environment variables
    const optionalEnvVars = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'];
    const missingOptional = optionalEnvVars.filter(varName => !process.env[varName]);
    
    if (missingOptional.length > 0) {
      console.warn(`[WARNING] Missing optional environment variables: ${missingOptional.join(', ')}`);
      console.warn('[WARNING] Some payment features may not work correctly.');
    }
  });
} catch (error: any) {
  console.error('[FATAL] Failed to start server:', error.message);
  
  if (error.message.includes('SUPABASE_URL') || error.message.includes('SUPABASE_SERVICE_ROLE_KEY')) {
    console.error('[FATAL] Required Supabase environment variables are missing.');
    console.error('[FATAL] Please set the following environment variables:');
    console.error('[FATAL] - SUPABASE_URL');
    console.error('[FATAL] - SUPABASE_SERVICE_ROLE_KEY');
  }
  
  process.exit(1);
}

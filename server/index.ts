import express, { Request, Response, NextFunction } from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import { rateLimit } from 'express-rate-limit';
import subscriptionRoutes from './routes/subscription.routes';
import logisticsRoutes from './routes/logistics.routes';
import connectRoutes from './routes/connect.routes';
import paymentRoutes from './routes/payment.routes';
import bookingRoutes from './routes/booking.routes';
import walletRoutes from './routes/wallet.routes';
import adminRoutes from './routes/admin.routes';
import webhookRoutes from './routes/webhook.routes';
import { dispatchService } from './services/dispatch.service';

import { HealthService } from './services/health.service';

dotenv.config();

const app = express();

app.use((req: any, res: any, next: any) => {
  const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:8100',
    'https://movabi.apps.evolsolution.com',
    'https://movabi-api.apps.evolsolution.com'
  ];

  const origin = req.headers.origin;

  if (origin && allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }

  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,apikey,x-client-info');

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
app.use('/api/webhook/stripe', bodyParser.raw({ type: 'application/json' }));

// Other routes use JSON body
app.use(bodyParser.json());

// Routes
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/logistics', logisticsRoutes);
app.use('/api/connect', connectRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/booking', bookingRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/webhook', webhookRoutes);

// Start Background Jobs
setInterval(() => {
  dispatchService.runDispatchEngine();
}, 10000);

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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

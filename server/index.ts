import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import subscriptionRoutes from './routes/subscription.routes';
import logisticsRoutes from './routes/logistics.routes';
import connectRoutes from './routes/connect.routes';
import { dispatchService } from './services/dispatch.service';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

// CORS configuration
app.use(cors());

// Stripe webhook needs raw body for signature verification
app.use('/api/subscriptions/webhook', bodyParser.raw({ type: 'application/json' }));

// Other routes use JSON body
app.use(bodyParser.json());

// Routes
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/logistics', logisticsRoutes);
app.use('/api/connect', connectRoutes);

// Start Dispatch Engine Loop
setInterval(() => {
  dispatchService.runDispatchEngine();
}, 10000); // Run every 10 seconds

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// Error handling middleware
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

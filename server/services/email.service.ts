import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Email Service
 * Uses nodemailer for real production email delivery.
 */
export class EmailService {
  private static transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_PORT || '587'),
    secure: process.env.EMAIL_SECURE === 'true',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  static async sendReceipt(email: string, details: {
    amount: number;
    currency: string;
    transactionId: string;
    description: string;
    date: Date;
  }) {
    console.log(`[EmailService] Sending receipt to ${email}:`, details);
    
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      console.warn('[EmailService] Email credentials missing. Skipping email delivery.');
      return false;
    }

    try {
      const info = await this.transporter.sendMail({
        from: `"Movabi" <${process.env.EMAIL_FROM || process.env.EMAIL_USER}>`,
        to: email,
        subject: `Your Movabi Receipt - ${details.description}`,
        text: `You paid ${details.amount} ${details.currency} for ${details.description} on ${details.date.toLocaleString()}. Transaction ID: ${details.transactionId}`,
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
            <h2 style="color: #10b981;">Movabi Receipt</h2>
            <p>Thank you for your payment.</p>
            <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
              <strong>Amount:</strong>
              <span>${details.amount} ${details.currency}</span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
              <strong>Description:</strong>
              <span>${details.description}</span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
              <strong>Date:</strong>
              <span>${details.date.toLocaleString()}</span>
            </div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
              <strong>Transaction ID:</strong>
              <span style="font-family: monospace; font-size: 12px;">${details.transactionId}</span>
            </div>
            <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
            <p style="font-size: 12px; color: #666;">If you have any questions, please contact our support team.</p>
          </div>
        `,
      });
      console.log('[EmailService] Email sent:', info.messageId);
      return true;
    } catch (error) {
      console.error('[EmailService] Error sending email:', error);
      return false;
    }
  }

  static async sendDriverReviewActionRequired(email: string, details: {
    driverName?: string | null;
    notes?: string | null;
    blockers: string[];
  }) {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      console.warn('[EmailService] Email credentials missing. Skipping driver review email.');
      return false;
    }

    const driverName = details.driverName?.trim() || 'there';
    const cleanBlockers = details.blockers.map(item => String(item || '').trim()).filter(Boolean);
    const blockerText = cleanBlockers.length
      ? cleanBlockers.map(item => `- ${item}`).join('\n')
      : '- Please review the admin notes in the Movabi app.';
    const notes = details.notes?.trim() || 'Your driver verification needs more information.';

    try {
      const info = await this.transporter.sendMail({
        from: `"Movabi" <${process.env.EMAIL_FROM || process.env.EMAIL_USER}>`,
        to: email,
        subject: 'Movabi Driver Verification: Action Required',
        text: `Hello ${driverName},\n\nYour driver verification needs more information.\n\n${notes}\n\nPlease open Movabi and update:\n${blockerText}\n\nThank you,\nMovabi`,
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #0f172a;">
            <h2 style="margin: 0 0 12px;">Movabi Driver Verification</h2>
            <p>Hello ${driverName},</p>
            <p>Your driver verification needs more information.</p>
            <p>${notes}</p>
            <p>Please open Movabi and update:</p>
            <ul>
              ${cleanBlockers.length
                ? cleanBlockers.map(item => `<li>${item}</li>`).join('')
                : '<li>Please review the admin notes in the Movabi app.</li>'}
            </ul>
            <p style="font-size: 12px; color: #64748b;">Thank you,<br>Movabi</p>
          </div>
        `
      });

      console.log('[EmailService] Driver review email sent:', info.messageId);
      return true;
    } catch (error) {
      console.error('[EmailService] Error sending driver review email:', error);
      return false;
    }
  }
}

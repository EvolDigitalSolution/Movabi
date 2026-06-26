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

  static async sendRegistrationOtp(email: string, code: string) {
    console.log(`[EmailService] Sending registration OTP to ${email}`);

    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      console.warn('[EmailService] Email credentials missing. Skipping registration OTP delivery.');
      return false;
    }

    try {
      const info = await this.transporter.sendMail({
        from: `"Movabi" <${process.env.EMAIL_FROM || process.env.EMAIL_USER}>`,
        to: email,
        subject: 'Your Movabi verification code',
        text: `Your Movabi verification code is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this email.`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 18px; color: #0f172a;">
            <h2 style="margin: 0 0 8px; color: #0f172a;">Verify your Movabi email</h2>
            <p style="margin: 0 0 22px; color: #475569; line-height: 1.5;">Use this code to finish creating your Movabi account. The code expires in 10 minutes.</p>
            <div style="font-size: 34px; font-weight: 800; letter-spacing: 10px; text-align: center; padding: 18px; border-radius: 16px; background: #fff7ed; color: #c2410c;">${code}</div>
            <p style="margin: 22px 0 0; color: #64748b; font-size: 13px; line-height: 1.5;">If you did not request this code, no account was created and you can ignore this email.</p>
          </div>
        `,
      });

      console.log('[EmailService] Registration OTP sent:', info.messageId);
      return true;
    } catch (error) {
      console.error('[EmailService] Error sending registration OTP:', error);
      return false;
    }
  }
}

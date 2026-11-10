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

  static async sendAdminMessageCopy(to:string, message:{id:string;subject:string;body:string;link:string}):Promise<boolean> {
    if(!process.env.EMAIL_USER || !process.env.EMAIL_PASS)return false;
    try {
      const transport=nodemailer.createTransport({
        host:process.env.EMAIL_HOST || 'smtp.gmail.com',port:parseInt(process.env.EMAIL_PORT || '587'),
        secure:process.env.EMAIL_SECURE==='true',auth:{user:process.env.EMAIL_USER,pass:process.env.EMAIL_PASS},
        connectionTimeout:10000,greetingTimeout:10000,socketTimeout:20000
      });
      const info=await transport.sendMail({
        from:`"Vaydu Support" <${process.env.EMAIL_FROM || process.env.EMAIL_USER}>`,to,
        messageId:`<vaydu-admin-message-${message.id}@movabi.app>`,
        subject:`Message from Vaydu — ${message.subject.replace(/[\r\n]/g,' ').slice(0,150)}`,
        text:[message.body,'',message.link,'','Please reply in the Vaydu app. Replies to this email are not added to your conversation.'].join('\n')
      });
      return Array.isArray(info.accepted)&&info.accepted.length>0;
    } catch {console.warn('[AdminMessages] Email delivery deferred for retry.');return false;}
  }

  static async sendBookingSupportNotification(recipients: string[], message: {id:string;replyTo?:string;subject:string;text:string}): Promise<boolean> {
    if (!recipients.length || !process.env.EMAIL_USER || !process.env.EMAIL_PASS) return false;
    try {
      const info = await this.transporter.sendMail({
        from: `"Vaydu Support" <${process.env.EMAIL_FROM || process.env.EMAIL_USER}>`,
        to: recipients, replyTo: message.replyTo || undefined,
        messageId: `<booking-support-${message.id}@movabi.app>`,
        subject: message.subject, text: message.text
      });
      return Array.isArray(info.accepted) && info.accepted.length > 0;
    } catch { console.warn('[EmailService] Support email queued for retry'); return false; }
  }

  static async sendDriverOnboardingAdminNotification(
    recipients: string[],
    message: { subject: string; text: string; html: string }
  ): Promise<boolean> {
    if (!recipients.length) {
      console.warn('[EmailService] No driver-onboarding Admin recipients configured.');
      return false;
    }
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      console.warn('[EmailService] Email credentials missing. Driver-onboarding event remains in the outbox.');
      return false;
    }
    try {
      const info = await this.transporter.sendMail({
        from: `"Vaydu" <${process.env.EMAIL_FROM || process.env.EMAIL_USER}>`,
        to: recipients.join(','),
        subject: message.subject,
        text: message.text,
        html: message.html
      });
      console.log('[EmailService] Driver-onboarding Admin email sent:', info.messageId);
      return true;
    } catch (error) {
      console.error('[EmailService] Driver-onboarding Admin email failed:', error);
      return false;
    }
  }

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
        from: `"Vaydu" <${process.env.EMAIL_FROM || process.env.EMAIL_USER}>`,
        to: email,
        subject: `Your Vaydu Receipt - ${details.description}`,
        text: `You paid ${details.amount} ${details.currency} for ${details.description} on ${details.date.toLocaleString()}. Transaction ID: ${details.transactionId}`,
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
            <h2 style="color: #10b981;">Vaydu Receipt</h2>
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
      : '- Please review the admin notes in the Vaydu app.';
    const notes = details.notes?.trim() || 'Your driver verification needs more information.';

    try {
      const info = await this.transporter.sendMail({
        from: `"Vaydu" <${process.env.EMAIL_FROM || process.env.EMAIL_USER}>`,
        to: email,
        subject: 'Vaydu Driver Verification: Action Required',
        text: `Hello ${driverName},\n\nYour driver verification needs more information.\n\n${notes}\n\nPlease open Vaydu and update:\n${blockerText}\n\nThank you,\nVaydu`,
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #0f172a;">
            <h2 style="margin: 0 0 12px;">Vaydu Driver Verification</h2>
            <p>Hello ${driverName},</p>
            <p>Your driver verification needs more information.</p>
            <p>${notes}</p>
            <p>Please open Vaydu and update:</p>
            <ul>
              ${cleanBlockers.length
                ? cleanBlockers.map(item => `<li>${item}</li>`).join('')
                : '<li>Please review the admin notes in the Vaydu app.</li>'}
            </ul>
            <p style="font-size: 12px; color: #64748b;">Thank you,<br>Vaydu</p>
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

  static async sendRegistrationOtp(email: string, code: string): Promise<boolean> {
    console.log(`[EmailService] Sending registration OTP to ${email}: ${code}`);
    
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      console.log('[EmailService] Email credentials not configured, skipping email send');
      return true; // Return true in development when no email config
    }

    try {
      const info = await this.transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: email,
        subject: 'Vaydu - Verification Code',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #1f2937;">Vaydu Verification Code</h2>
            <p style="font-size: 16px; color: #374151;">Your verification code is:</p>
            <div style="background-color: #f3f4f6; padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0;">
              <span style="font-size: 24px; font-weight: bold; color: #1f2937; letter-spacing: 2px;">${code}</span>
            </div>
            <p style="font-size: 14px; color: #6b7280;">This code will expire in 10 minutes.</p>
            <p style="font-size: 12px; color: #64748b;">Thank you,<br>Vaydu</p>
          </div>
        `
      });

      console.log('[EmailService] Registration OTP email sent:', info.messageId);
      return true;
    } catch (error) {
      console.error('[EmailService] Error sending registration OTP:', error);
      return false;
    }
  }
}

import { Injectable, inject } from '@angular/core';
import { AppConfigService } from '../config/app-config.service';
import { Booking } from '../../../shared/models/booking.model';

@Injectable({
  providedIn: 'root'
})
export class EmailService {
  private config = inject(AppConfigService);

  /**
   * Send job completion receipt to customer and driver
   * In production, this would call a Supabase Edge Function or an external API (SendGrid/Postmark)
   */
  async sendJobReceipt(booking: Booking) {
    console.log('[EmailService] Generating receipts for job:', booking.id);
    
    const customerEmail = booking.customer?.email;
    const driverEmail = booking.driver?.email;

    if (!customerEmail && !driverEmail) {
      console.warn('[EmailService] No emails found for receipt generation');
      return;
    }

    const receiptData = {
      jobId: booking.id,
      date: new Date().toLocaleDateString(),
      service: booking.service_type?.name,
      total: this.config.formatCurrency(booking.total_price + (booking.errand_funding?.amount_reserved || 0)),
      serviceFee: this.config.formatCurrency(booking.total_price),
      itemBudget: booking.errand_funding ? this.config.formatCurrency(booking.errand_funding.amount_reserved) : null,
      pickup: booking.pickup_address,
      dropoff: booking.dropoff_address,
      distance: booking.estimated_distance ? `${booking.estimated_distance.toFixed(1)} km` : 'N/A',
      duration: booking.estimated_duration ? `${Math.ceil(booking.estimated_duration / 60)} mins` : 'N/A'
    };

    // Log the "sending" action
    if (customerEmail) {
      console.log(`[EmailService] Sending customer receipt to ${customerEmail}`, receiptData);
    }
    if (driverEmail) {
      console.log(`[EmailService] Sending driver receipt to ${driverEmail}`, receiptData);
    }

    // TODO: Implement actual email sending via Supabase Edge Functions
    // await this.supabase.functions.invoke('send-receipt', { body: { bookingId: booking.id } });
  }
}

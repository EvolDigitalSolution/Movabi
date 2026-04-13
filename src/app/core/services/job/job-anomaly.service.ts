import { Injectable } from '@angular/core';
import { Job } from '@shared/models/booking.model';

export interface JobAnomaly {
  jobId: string;
  type: 'paid_not_searching' | 'searching_too_long' | 'accepted_stuck' | 'completed_no_earnings' | 'payment_stuck';
  severity: 'low' | 'medium' | 'high';
  message: string;
}

@Injectable({
  providedIn: 'root'
})
export class JobAnomalyService {
  
  detectAnomalies(jobs: Job[]): JobAnomaly[] {
    const anomalies: JobAnomaly[] = [];
    const now = new Date().getTime();

    jobs.forEach(job => {
      const createdAt = new Date(job.created_at).getTime();
      const ageInMinutes = (now - createdAt) / (1000 * 60);

      // 1. Paid but not searching
      if (job.payment_status === 'paid' && job.status === 'requested') {
        anomalies.push({
          jobId: job.id,
          type: 'paid_not_searching',
          severity: 'high',
          message: 'Job is paid but stuck in requested state (not dispatchable).'
        });
      }

      // 2. Searching too long (> 5 mins)
      if (job.status === 'searching' && ageInMinutes > 5) {
        anomalies.push({
          jobId: job.id,
          type: 'searching_too_long',
          severity: 'medium',
          message: `Job has been searching for a driver for ${Math.round(ageInMinutes)} minutes.`
        });
      }

      // 3. Accepted but no progress (> 15 mins)
      if (job.status === 'accepted' && ageInMinutes > 15) {
        anomalies.push({
          jobId: job.id,
          type: 'accepted_stuck',
          severity: 'medium',
          message: 'Driver accepted but has not arrived at pickup after 15 minutes.'
        });
      }

      // 4. Completed without earnings (placeholder logic - usually requires checking earnings table)
      // For now, we'll flag if it's completed but platform_fee is 0 or null
      if (job.status === 'completed' && (!job.platform_fee || job.platform_fee === 0)) {
        anomalies.push({
          jobId: job.id,
          type: 'completed_no_earnings',
          severity: 'high',
          message: 'Job completed but financials (platform fee) are missing.'
        });
      }

      // 5. Payment stuck (> 10 mins)
      if (job.payment_status === 'pending' && job.payment_intent_id && ageInMinutes > 10) {
        anomalies.push({
          jobId: job.id,
          type: 'payment_stuck',
          severity: 'medium',
          message: 'Payment intent created but not confirmed after 10 minutes.'
        });
      }
    });

    return anomalies;
  }
}

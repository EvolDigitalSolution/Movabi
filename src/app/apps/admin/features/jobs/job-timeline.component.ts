import { Component, inject, input, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { JobEventService } from '@core/services/job/job-event.service';
import { JobEvent } from '@shared/models/booking.model';

@Component({
  selector: 'app-job-timeline',
  template: `
    <div class="space-y-6">
      @if (loading()) {
        <div class="flex justify-center py-10">
          <ion-spinner name="crescent" color="primary"></ion-spinner>
        </div>
      } @else if (events().length === 0) {
        <div class="text-center py-10 text-slate-400 font-bold uppercase tracking-widest text-xs">
          No events recorded for this job.
        </div>
      } @else {
        <div class="relative pl-8 space-y-8">
          <!-- Vertical Line -->
          <div class="absolute left-3 top-2 bottom-2 w-0.5 bg-slate-100"></div>

          @for (event of events(); track event.id) {
            <div class="relative">
              <!-- Dot -->
              <div class="absolute -left-[25px] top-1.5 w-4 h-4 rounded-full border-4 border-white shadow-sm"
                   [class.bg-blue-500]="event.event_type === 'job_created'"
                   [class.bg-emerald-500]="event.event_type === 'payment_succeeded' || event.event_type === 'job_completed'"
                   [class.bg-amber-500]="event.event_type === 'payment_initiated' || event.event_type === 'driver_assigned'"
                   [class.bg-rose-500]="event.event_type === 'job_cancelled' || event.event_type === 'payment_failed'"
                   [class.bg-slate-400]="!['job_created', 'payment_succeeded', 'job_completed', 'payment_initiated', 'driver_assigned', 'job_cancelled', 'payment_failed'].includes(event.event_type)">
              </div>

              <div class="space-y-1">
                <div class="flex items-center justify-between">
                  <h4 class="text-sm font-black text-slate-900 uppercase tracking-tight">
                    {{ formatEventType(event.event_type) }}
                  </h4>
                  <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                    {{ event.created_at | date:'HH:mm:ss' }}
                  </span>
                </div>
                <p class="text-xs text-slate-500 font-medium">{{ event.notes }}</p>
                @if (event.actor_role) {
                  <div class="flex items-center gap-2 mt-2">
                    <span class="text-[9px] font-black px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 uppercase tracking-widest">
                      {{ event.actor_role }}
                    </span>
                    @if (event.metadata && event.metadata['from'] && event.metadata['to']) {
                      <span class="text-[9px] font-bold text-slate-400 uppercase tracking-widest">
                        {{ event.metadata['from'] }} → {{ event.metadata['to'] }}
                      </span>
                    }
                  </div>
                }
              </div>
            </div>
          }
        </div>
      }
    </div>
  `,
  standalone: true,
  imports: [CommonModule, IonicModule]
})
export class JobTimelineComponent implements OnInit {
  jobId = input.required<string>();
  private eventService = inject(JobEventService);

  events = signal<JobEvent[]>([]);
  loading = signal(true);

  async ngOnInit() {
    try {
      const data = await this.eventService.getJobEvents(this.jobId());
      this.events.set(data);
    } catch (error) {
      console.error('Error loading job events:', error);
    } finally {
      this.loading.set(false);
    }
  }

  formatEventType(type: string): string {
    return type.replace(/_/g, ' ');
  }
}

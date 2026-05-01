import { Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { JobEventService } from '@core/services/job/job-event.service';
import { JobEvent } from '@shared/models/booking.model';

@Component({
  selector: 'app-job-timeline',
  standalone: true,
  imports: [CommonModule, IonicModule],
  template: `
    <div class="h-full max-h-[75vh] overflow-hidden flex flex-col bg-white">
      <div class="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-3">
        <div>
          <h3 class="text-base font-bold text-slate-900">Job Timeline</h3>
          <p class="text-xs text-slate-500 font-medium">Latest job events and status changes</p>
        </div>

        <button
          type="button"
          (click)="reload()"
          class="h-9 px-3 rounded-xl bg-slate-50 text-slate-600 hover:bg-blue-50 hover:text-blue-600 text-xs font-bold border border-slate-100"
        >
          Refresh
        </button>
      </div>

      <div class="flex-1 overflow-y-auto p-5">
        @if (loading()) {
          <div class="flex justify-center py-10">
            <ion-spinner name="crescent" color="primary"></ion-spinner>
          </div>
        } @else if (events().length === 0) {
          <div class="text-center py-10">
            <div class="w-14 h-14 rounded-2xl bg-slate-50 border border-slate-100 flex items-center justify-center mx-auto mb-4">
              <ion-icon name="time-outline" class="text-2xl text-slate-300"></ion-icon>
            </div>
            <p class="text-slate-400 font-bold uppercase tracking-widest text-xs">
              No events recorded for this job.
            </p>
          </div>
        } @else {
          <div class="relative pl-7 space-y-6">
            <div class="absolute left-2.5 top-2 bottom-2 w-0.5 bg-slate-100"></div>

            @for (event of pagedEvents(); track trackEvent(event, $index)) {
              <div class="relative">
                <div
                  class="absolute -left-[25px] top-1.5 w-4 h-4 rounded-full border-4 border-white shadow-sm"
                  [class.bg-blue-500]="event.event_type === 'job_created'"
                  [class.bg-emerald-500]="event.event_type === 'payment_succeeded' || event.event_type === 'job_completed'"
                  [class.bg-amber-500]="event.event_type === 'payment_initiated' || event.event_type === 'driver_assigned'"
                  [class.bg-rose-500]="event.event_type === 'job_cancelled' || event.event_type === 'payment_failed'"
                  [class.bg-slate-400]="!isKnownEventType(event.event_type)"
                ></div>

                <div class="rounded-2xl border border-slate-100 bg-slate-50/50 p-4">
                  <div class="flex items-start justify-between gap-4">
                    <h4 class="text-xs font-black text-slate-900 uppercase tracking-wide">
                      {{ formatEventType(event.event_type) }}
                    </h4>

                    <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest whitespace-nowrap">
                      {{ formatDateTime(event.created_at) }}
                    </span>
                  </div>

                  <p class="text-xs text-slate-600 font-medium mt-2 leading-relaxed">
                    {{ event.notes || 'No notes provided.' }}
                  </p>

                  @if (event.actor_role || hasTransition(event)) {
                    <div class="flex flex-wrap items-center gap-2 mt-3">
                      @if (event.actor_role) {
                        <span class="text-[9px] font-black px-2 py-1 rounded-lg bg-white border border-slate-100 text-slate-500 uppercase tracking-widest">
                          {{ event.actor_role }}
                        </span>
                      }

                      @if (hasTransition(event)) {
                        <span class="text-[10px] font-bold text-slate-500">
                          {{ getTransitionFrom(event) }} → {{ getTransitionTo(event) }}
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

      @if (!loading() && totalPages() > 1) {
        <div class="px-5 py-4 border-t border-slate-100 flex items-center justify-between gap-3 bg-white">
          <p class="text-xs text-slate-500 font-semibold">
            Page {{ currentPage() }} of {{ totalPages() }} · {{ events().length }} events
          </p>

          <div class="flex items-center gap-2">
            <button
              type="button"
              (click)="prevPage()"
              [disabled]="currentPage() <= 1"
              class="h-9 px-3 rounded-xl bg-slate-50 text-slate-600 disabled:opacity-40 text-xs font-bold border border-slate-100"
            >
              Previous
            </button>

            <button
              type="button"
              (click)="nextPage()"
              [disabled]="currentPage() >= totalPages()"
              class="h-9 px-3 rounded-xl bg-blue-600 text-white disabled:opacity-40 text-xs font-bold"
            >
              Next
            </button>
          </div>
        </div>
      }
    </div>
  `
})
export class JobTimelineComponent implements OnInit {
  jobId = input.required<string>();

  private eventService = inject(JobEventService);

  events = signal<JobEvent[]>([]);
  loading = signal(true);
  currentPage = signal(1);
  pageSize = signal(8);

  totalPages = computed(() =>
    Math.max(1, Math.ceil(this.events().length / this.pageSize()))
  );

  pagedEvents = computed(() => {
    const page = Math.min(this.currentPage(), this.totalPages());
    const size = this.pageSize();
    const start = (page - 1) * size;

    return this.events().slice(start, start + size);
  });

  async ngOnInit() {
    await this.reload();
  }

  async reload() {
    const id = this.jobId();

    if (!id) {
      console.warn('[JobTimeline] Missing jobId');
      this.events.set([]);
      this.loading.set(false);
      return;
    }

    await this.loadEvents(id);
  }

  async loadEvents(jobId: string) {
    try {
      this.loading.set(true);

      const data = await this.eventService.getJobEvents(jobId);
      const safeEvents = Array.isArray(data) ? data : [];

      this.events.set(
        safeEvents.sort((a, b) =>
          new Date((b as any)?.created_at || 0).getTime() -
          new Date((a as any)?.created_at || 0).getTime()
        )
      );

      this.currentPage.set(1);
    } catch (error) {
      console.error('Error loading job events:', error);
      this.events.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  nextPage() {
    this.currentPage.update((page) => Math.min(page + 1, this.totalPages()));
  }

  prevPage() {
    this.currentPage.update((page) => Math.max(page - 1, 1));
  }

  formatEventType(type: string | null | undefined): string {
    return String(type || 'unknown_event').replace(/_/g, ' ');
  }

  hasTransition(event: JobEvent): boolean {
    const metadata = (event as any)?.metadata || {};
    return !!(metadata.from && metadata.to);
  }

  getTransitionFrom(event: JobEvent): string {
    return String((event as any)?.metadata?.from || '');
  }

  getTransitionTo(event: JobEvent): string {
    return String((event as any)?.metadata?.to || '');
  }

  isKnownEventType(type: string | null | undefined): boolean {
    return [
      'job_created',
      'payment_succeeded',
      'job_completed',
      'payment_initiated',
      'driver_assigned',
      'job_cancelled',
      'payment_failed'
    ].includes(type || '');
  }

  formatDateTime(value: string | null | undefined): string {
    if (!value) return 'N/A';

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return String(value);
    }

    return `${date.toLocaleDateString()} · ${date.toLocaleTimeString()}`;
  }

  trackEvent(event: JobEvent, index: number): string {
    return String((event as any)?.id || `${(event as any)?.event_type || 'event'}-${index}`);
  }
}

import { Component, inject, OnInit, OnDestroy, ViewChild, ElementRef, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { JobService } from '@core/services/job/job.service';
import { LocationService } from '@core/services/logistics/location.service';
import { MapService } from '@core/services/logistics/map.service';
import { ProfileService } from '@core/services/profile/profile.service';
import { Job, DriverLocation } from '@shared/models/booking.model';
import { RealtimeChannel } from '@supabase/supabase-js';

import { BadgeComponent } from '../../../../shared/ui/badge';

@Component({
  selector: 'app-job-monitoring',
  template: `
    <div class="space-y-10">
      <div class="bg-white rounded-[2.5rem] border border-slate-100 shadow-2xl shadow-slate-200/40 overflow-hidden">
        <div class="p-10 border-b border-slate-50">
          <h3 class="text-2xl font-display font-bold text-slate-900">Live Fleet View</h3>
          <p class="text-slate-500 font-medium mt-1">Real-time driver positions across the tenant.</p>
        </div>
        <div #mapContainer class="h-[500px] bg-slate-100 relative">
          <!-- Map Overlay for Premium Feel -->
          <div class="absolute top-6 left-6 z-10 bg-white/90 backdrop-blur-md p-4 rounded-2xl border border-white shadow-xl shadow-slate-900/5">
            <div class="flex items-center gap-3">
              <div class="w-3 h-3 rounded-full bg-emerald-500 animate-pulse"></div>
              <span class="text-xs font-bold text-slate-900 uppercase tracking-widest">Live Tracking Active</span>
            </div>
          </div>
        </div>
      </div>

      <div class="bg-white rounded-[2.5rem] border border-slate-100 shadow-2xl shadow-slate-200/40 overflow-hidden">
        <div class="p-10 border-b border-slate-50 flex items-center justify-between">
          <div>
            <h3 class="text-2xl font-display font-bold text-slate-900">Van Moving Monitoring</h3>
            <p class="text-slate-500 font-medium mt-1">Real-time overview of all moving jobs.</p>
          </div>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="bg-slate-50/50">
                <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Job ID</th>
                <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Customer</th>
                <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Driver</th>
                <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Route</th>
                <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Status</th>
                <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Plan</th>
                <th class="px-10 py-6 text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em]">Financials</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-50">
              @for (job of jobs(); track job.id) {
                <tr class="hover:bg-slate-50/80 transition-all group">
                  <td class="px-10 py-6">
                    <span class="text-[10px] font-bold text-slate-400 uppercase tracking-widest bg-slate-100 px-2 py-1 rounded-md">#{{ job.id.slice(0,8) }}</span>
                  </td>
                  <td class="px-10 py-6">
                    <div class="flex items-center gap-4">
                      <div class="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center text-blue-600 font-bold text-xs border border-blue-100">
                        {{ job.customer?.first_name?.[0] }}
                      </div>
                      <div>
                        <p class="text-sm font-bold text-slate-900">{{ job.customer?.first_name }} {{ job.customer?.last_name }}</p>
                        <p class="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">{{ job.customer?.email }}</p>
                      </div>
                    </div>
                  </td>
                  <td class="px-10 py-6">
                    @if (job.driver) {
                      <div class="flex items-center gap-4">
                        <div class="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center text-emerald-600 font-bold text-xs border border-emerald-100">
                          {{ job.driver.first_name[0] }}
                        </div>
                        <div>
                          <p class="text-sm font-bold text-slate-900">{{ job.driver.first_name }} {{ job.driver.last_name }}</p>
                          <p class="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">{{ job.driver.phone }}</p>
                        </div>
                      </div>
                    } @else {
                      <app-badge variant="warning">Unassigned</app-badge>
                    }
                  </td>
                  <td class="px-10 py-6">
                    <div class="text-[10px] space-y-2 font-bold uppercase tracking-widest">
                      <div class="flex items-center gap-2">
                        <span class="text-slate-400 min-w-[32px]">From:</span>
                        <span class="text-slate-600 line-clamp-1">{{ job.pickup_address }}</span>
                      </div>
                      <div class="flex items-center gap-2">
                        <span class="text-slate-400 min-w-[32px]">To:</span>
                        <span class="text-slate-600 line-clamp-1">{{ job.dropoff_address }}</span>
                      </div>
                    </div>
                  </td>
                  <td class="px-10 py-6">
                    <app-badge [variant]="getStatusVariant(job.status)">
                      {{ job.status }}
                    </app-badge>
                  </td>
                  <td class="px-10 py-6">
                    <div class="flex flex-col gap-1">
                      <app-badge [variant]="job.pricing_plan_used === 'pro' ? 'primary' : 'secondary'">
                        {{ job.pricing_plan_used || 'starter' | uppercase }}
                      </app-badge>
                      @if (job.commission_rate_used) {
                        <span class="text-[10px] text-slate-400 font-bold uppercase tracking-widest text-center">
                          {{ job.commission_rate_used }}% Fee
                        </span>
                      }
                    </div>
                  </td>
                  <td class="px-10 py-6">
                    <div class="flex flex-col gap-1">
                      <span class="text-sm font-black text-slate-900">£{{ job.price }}</span>
                      @if (job.status === 'completed' && job.driver_payout) {
                        <div class="flex flex-col text-[10px] font-bold uppercase tracking-widest text-slate-400">
                          <span class="text-emerald-600">Payout: £{{ job.driver_payout }}</span>
                          <span class="text-blue-600">Platform: £{{ job.platform_fee }}</span>
                        </div>
                      }
                    </div>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `,
  standalone: true,
  imports: [CommonModule, IonicModule, BadgeComponent]
})
export class JobMonitoringComponent implements OnInit, OnDestroy {
  @ViewChild('mapContainer') mapContainer?: ElementRef;

  private jobService = inject(JobService);
  private locationService = inject(LocationService);
  private mapService = inject(MapService);
  private profileService = inject(ProfileService);

  jobs = signal<Job[]>([]);
  private map: google.maps.Map | null = null;
  private markers = new Map<string, google.maps.Marker>();
  private jobChannel?: RealtimeChannel;
  private locationChannel?: RealtimeChannel;

  async ngOnInit() {
    await this.loadJobs();
    this.jobChannel = this.jobService.subscribeToJobs(() => this.loadJobs());
    await this.mapService.loadGoogleMaps();
    this.initMap();
    this.subscribeToAllLocations();
  }

  ngOnDestroy() {
    this.jobChannel?.unsubscribe();
    this.locationChannel?.unsubscribe();
  }

  initMap() {
    if (!this.mapContainer) return;
    this.map = this.mapService.createMap(this.mapContainer.nativeElement, {
      center: { lat: 51.5074, lng: -0.1278 }, // London
      zoom: 11,
      disableDefaultUI: true
    });
  }

  subscribeToAllLocations() {
    const profile = this.profileService.profile();
    if (!profile) return;

    this.locationChannel = this.locationService.subscribeToAllTenantLocations(profile.tenant_id, (location) => {
      this.updateMarker(location);
    });
  }

  updateMarker(location: DriverLocation) {
    if (!this.map) return;
    const pos = { lat: location.lat, lng: location.lng };
    let marker = this.markers.get(location.driver_id);
    
    if (marker) {
      marker.setPosition(pos);
    } else {
      marker = this.mapService.addMarker(this.map, pos, 'https://maps.google.com/mapfiles/ms/icons/bus.png');
      this.markers.set(location.driver_id, marker);
    }
  }

  async loadJobs() {
    this.jobs.set(await this.jobService.getAllJobs());
  }

  getStatusVariant(status: string) {
    switch (status) {
      case 'pending': return 'warning';
      case 'accepted': return 'info';
      case 'in_progress': return 'primary';
      case 'completed': return 'success';
      case 'cancelled': return 'error';
      default: return 'secondary';
    }
  }
}

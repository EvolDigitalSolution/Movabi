import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, OnChanges, OnDestroy, Output, SimpleChanges, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IonicModule } from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  bagHandleOutline,
  briefcaseOutline,
  cartOutline,
  checkmarkCircleOutline,
  chevronDownOutline,
  chevronUpOutline,
  closeOutline,
  constructOutline,
  cubeOutline,
  documentTextOutline,
  ellipsisHorizontalCircleOutline,
  heartOutline,
  locationOutline,
  medicalOutline,
  personOutline,
  restaurantOutline,
  searchOutline,
  shirtOutline,
  storefrontOutline
} from 'ionicons/icons';
import {
  LocalServiceCategory,
  LocalServiceProvider,
  LocalServicesService,
  LocalServiceSelection
} from '../../../core/services/local-services.service';

@Component({
  selector: 'app-local-service-selector',
  standalone: true,
  imports: [CommonModule, FormsModule, IonicModule],
  template: `
    <section class="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm" aria-live="polite">
      <button
        type="button"
        class="local-service-summary"
        [attr.aria-expanded]="sectionExpanded()"
        (click)="toggleSection()">
        <span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-orange-50 text-orange-600">
          <ion-icon [name]="selectedIcon()" aria-label="Local service"></ion-icon>
        </span>
        <span class="min-w-0 flex-1 text-left">
          <p class="text-[11px] font-black uppercase tracking-[0.2em] text-slate-500">Local service</p>
          <h3 class="mt-1 truncate text-base font-black text-slate-950">{{ selectedTitle() }}</h3>
          <span class="block truncate text-xs font-semibold text-slate-500">{{ selectedSubtitle() }}</span>
        </span>
        <span class="shrink-0 text-[10px] font-black uppercase tracking-widest text-orange-600">
          {{ sectionExpanded() ? 'Close' : (selectedProviderId ? 'Change' : 'Choose') }}
        </span>
        @if (loading()) {
          <span class="text-xs font-bold text-slate-500">Loading...</span>
        }
      </button>

      @if (sectionExpanded()) {
        <div class="mt-3 max-h-[60vh] overflow-y-auto overscroll-contain">
          @if (fallbackActive()) {
            <div class="mt-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <p class="text-sm font-black text-slate-900">No nearby providers found yet.</p>
              <p class="mt-1 text-xs font-semibold text-slate-500">Search by name or enter one manually.</p>
            </div>
          }

        @if (categories().length) {
          <div class="mt-4 space-y-3">
            @for (category of categories(); track category.id) {
              <div class="rounded-2xl border border-slate-200 bg-slate-50">
                <button
                  type="button"
                  class="flex min-h-11 w-full items-center gap-3 px-4 py-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-500"
                  [attr.aria-expanded]="selectedCategoryId === category.id"
                  (click)="selectCategory(category)">
                  <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-white text-orange-600">
                    <ion-icon [name]="resolveCategoryIcon(category)" aria-label="Category"></ion-icon>
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="block text-sm font-black text-slate-950">{{ category.categoryName }}</span>
                    @if (category.categoryDescription) {
                      <span class="block truncate text-xs font-semibold text-slate-500">{{ category.categoryDescription }}</span>
                    }
                  </span>
                  <ion-icon
                    [name]="selectedCategoryId === category.id ? 'chevron-up-outline' : 'chevron-down-outline'"
                    aria-label="Toggle category">
                  </ion-icon>
                </button>

                @if (selectedCategoryId === category.id) {
                  <div class="border-t border-slate-200 bg-white px-4 py-3">
                    @if (favourites().length) {
                      <div class="mb-3">
                        <p class="mb-2 text-[10px] font-black uppercase tracking-widest text-slate-400">Favourites</p>
                        <div class="space-y-2">
                          @for (provider of favourites(); track provider.id) {
                            <button type="button" class="provider-card" (click)="selectProvider(category, provider)">
                              <span class="provider-logo">
                                <ion-icon name="heart-outline" aria-label="Favourite"></ion-icon>
                              </span>
                              <span class="provider-body">
                                <span class="provider-name">{{ provider.providerName }}</span>
                                <span class="provider-address">{{ provider.providerAddress || provider.address || 'Saved provider' }}</span>
                              </span>
                            </button>
                          }
                        </div>
                      </div>
                    }

                    @if (recent().length) {
                      <div class="mb-3">
                        <p class="mb-2 text-[10px] font-black uppercase tracking-widest text-slate-400">Recent</p>
                        <div class="space-y-2">
                          @for (provider of recent(); track provider.id) {
                            <button type="button" class="provider-card" (click)="selectProvider(category, provider)">
                              <span class="provider-logo">
                                @if (provider.providerLogoUrl || provider.logoUrl) {
                                  <img [src]="provider.providerLogoUrl || provider.logoUrl || ''" [alt]="provider.providerName + ' logo'" (error)="hideBrokenImage($event)">
                                } @else {
                                  <ion-icon name="storefront-outline" aria-label="Previously used provider"></ion-icon>
                                }
                              </span>
                              <span class="provider-body">
                                <span class="provider-name">{{ provider.providerName }}</span>
                                <span class="provider-address">{{ provider.providerAddress || provider.address || 'Previously used' }}</span>
                              </span>
                            </button>
                          }
                        </div>
                      </div>
                    }

                    <div class="mb-3 flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2">
                      <ion-icon name="search-outline" class="text-slate-400" aria-label="Search"></ion-icon>
                      <input
                        [(ngModel)]="searchText"
                        (input)="scheduleProviderSearch(category)"
                        class="min-h-10 flex-1 bg-transparent text-sm font-semibold text-slate-900 outline-none"
                        placeholder="Search nearby by name">
                      @if (searchText) {
                        <button type="button" class="h-10 w-10 rounded-xl text-slate-500" (click)="clearSearch(category)" aria-label="Clear search">
                          <ion-icon name="close-outline"></ion-icon>
                        </button>
                      }
                    </div>

                    <div class="mb-3 flex flex-wrap gap-2">
                      @for (option of radiusOptions; track option.value) {
                        <button
                          type="button"
                          class="radius-chip"
                          [class.active]="radiusKm() === option.value"
                          (click)="setRadius(category, option.value)">
                          {{ option.label }}
                        </button>
                      }
                    </div>

                    @if (providersLoading()) {
                      <div class="space-y-2" aria-label="Loading nearby providers">
                        <div class="h-16 animate-pulse rounded-2xl bg-slate-100"></div>
                        <div class="h-16 animate-pulse rounded-2xl bg-slate-100"></div>
                      </div>
                    } @else if (providers().length) {
                      <p class="sr-only">{{ providers().length }} nearby providers found.</p>
                      <div class="space-y-2">
                        @for (provider of providers(); track provider.id) {
                          <button
                            type="button"
                            class="provider-card"
                            [class.selected]="selectedProviderId === provider.id || selectedProviderId === provider.providerId"
                            [attr.aria-pressed]="selectedProviderId === provider.id || selectedProviderId === provider.providerId"
                            (click)="selectProvider(category, provider)">
                            <span class="provider-logo">
                              @if (provider.providerLogoUrl || provider.logoUrl) {
                                <img [src]="provider.providerLogoUrl || provider.logoUrl || ''" [alt]="provider.providerName + ' logo'" (error)="hideBrokenImage($event)">
                              } @else {
                                <ion-icon [name]="resolveCategoryIcon(category)" [attr.aria-label]="category.categoryName + ' category icon'"></ion-icon>
                              }
                            </span>
                            <span class="provider-body">
                              <span class="provider-name">
                                {{ provider.providerName }}
                                @if (provider.verified) {
                                  <ion-icon name="checkmark-circle-outline" class="text-emerald-600" aria-label="Verified"></ion-icon>
                                }
                              </span>
                              @if (provider.providerAddress || provider.address) {
                                <span class="provider-address">{{ provider.providerAddress || provider.address }}</span>
                              }
                              <span class="provider-meta">
                                @if (provider.distanceKm !== null && provider.distanceKm !== undefined) {
                                  {{ provider.distanceKm }} km away
                                }
                                @if (provider.openStatus) {
                                  <span> {{ provider.openStatus }}</span>
                                }
                              </span>
                            </span>
                          </button>
                        }
                      </div>
                    } @else {
                      <div class="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-4">
                        <p class="text-sm font-black text-slate-900">No nearby results for {{ searchText || category.categoryName }}.</p>
                        <p class="mt-1 text-xs font-semibold text-slate-500">Try a wider search or enter the provider manually.</p>
                        <div class="mt-3 flex flex-wrap gap-2">
                          <button type="button" class="fallback-action" (click)="setRadius(category, 20)">
                            Search wider
                          </button>
                          @if (category.allowCustomProvider && allowCustomEntry) {
                            <button type="button" class="fallback-action secondary" (click)="chooseCustom(category)">
                              Enter provider manually
                            </button>
                          }
                        </div>
                      </div>
                    }

                    @if (category.allowCustomProvider && allowCustomEntry) {
                      <button
                        type="button"
                        class="mt-3 min-h-11 w-full rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-3 text-sm font-black text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-orange-500"
                        (click)="chooseCustom(category)">
                        Enter provider manually
                      </button>
                    }
                  </div>
                }
              </div>
            }
          </div>
        } @else if (!loading()) {
          <div class="mt-4 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-4">
            <p class="text-sm font-black text-slate-900">No nearby providers found yet.</p>
            <p class="mt-1 text-xs font-semibold text-slate-500">Search by name or enter one manually.</p>
          </div>
        }
        </div>
      }
    </section>
  `,
  styles: [`
    .local-service-summary {
      min-height: 68px;
      width: 100%;
      display: flex;
      align-items: center;
      gap: 0.75rem;
      border-radius: 1.25rem;
      border: 1px solid #e2e8f0;
      background: #f8fafc;
      padding: 0.75rem;
    }

    .provider-card {
      min-height: 56px;
      width: 100%;
      display: flex;
      align-items: center;
      gap: 0.75rem;
      border: 1px solid #e2e8f0;
      border-radius: 1rem;
      background: #fff;
      padding: 0.625rem;
      text-align: left;
      transition: transform 120ms ease, border-color 120ms ease, background 120ms ease;
    }

    .provider-card:active {
      transform: scale(0.99);
    }

    .provider-card.selected {
      border-color: #f59e0b;
      background: #fff7ed;
    }

    .provider-logo {
      width: 42px;
      height: 42px;
      flex: 0 0 42px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      border-radius: 0.875rem;
      background: #f8fafc;
      color: #64748b;
    }

    .provider-logo img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .provider-body {
      min-width: 0;
      flex: 1;
    }

    .provider-name {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      color: #0f172a;
      font-size: 0.875rem;
      font-weight: 900;
      line-height: 1.2;
    }

    .provider-address,
    .provider-meta {
      display: block;
      color: #64748b;
      font-size: 0.75rem;
      font-weight: 700;
      line-height: 1.25;
    }

    .provider-address {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .provider-meta {
      color: #ea580c;
    }

    .radius-chip {
      min-height: 36px;
      border-radius: 999px;
      border: 1px solid #e2e8f0;
      background: #fff;
      color: #475569;
      padding: 0 0.875rem;
      font-size: 0.75rem;
      font-weight: 900;
    }

    .radius-chip.active {
      background: #f97316;
      border-color: #f97316;
      color: #fff;
    }

    .fallback-action {
      min-height: 44px;
      border-radius: 999px;
      border: 1px solid #f97316;
      background: #f97316;
      color: #111827;
      padding: 0.55rem 0.9rem;
      font-size: 0.75rem;
      font-weight: 900;
    }

    .fallback-action.secondary {
      border-color: #cbd5e1;
      background: #fff;
      color: #334155;
    }
  `]
})
export class LocalServiceSelectorComponent implements OnChanges, OnDestroy {
  @Input() countryCode = 'GB';
  @Input() serviceSlug = 'errand';
  @Input() currentLocation?: { lat?: number | null; lng?: number | null } | null;
  @Input() selectedCategoryId?: string | null;
  @Input() selectedProviderId?: string | null;
  @Input() allowCustomEntry = true;

  @Output() categoryChange = new EventEmitter<LocalServiceCategory>();
  @Output() providerChange = new EventEmitter<LocalServiceSelection>();
  @Output() customProviderChange = new EventEmitter<LocalServiceSelection>();

  private localServices = inject(LocalServicesService);
  private searchTimer?: ReturnType<typeof setTimeout>;
  categories = signal<LocalServiceCategory[]>([]);
  providers = signal<LocalServiceProvider[]>([]);
  recent = signal<LocalServiceProvider[]>([]);
  favourites = signal<LocalServiceProvider[]>([]);
  loading = signal(false);
  providersLoading = signal(false);
  fallbackActive = signal(false);
  sectionExpanded = signal(false);
  selectedCategory = signal<LocalServiceCategory | null>(null);
  selectedProvider = signal<LocalServiceProvider | null>(null);
  radiusKm = signal(10);
  searchText = '';
  radiusOptions = [
    { label: 'Nearby', value: 3 },
    { label: '5 km', value: 5 },
    { label: '10 km', value: 10 },
    { label: 'Search wider', value: 20 }
  ];

  constructor() {
    addIcons({
      bagHandleOutline,
      briefcaseOutline,
      cartOutline,
      checkmarkCircleOutline,
      chevronDownOutline,
      chevronUpOutline,
      closeOutline,
      constructOutline,
      cubeOutline,
      documentTextOutline,
      ellipsisHorizontalCircleOutline,
      heartOutline,
      locationOutline,
      medicalOutline,
      personOutline,
      restaurantOutline,
      searchOutline,
      shirtOutline,
      storefrontOutline
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['countryCode'] || changes['serviceSlug']) {
      void this.loadCategories();
    }
    if (changes['currentLocation'] && this.selectedCategoryId) {
      const category = this.categories().find(item => item.id === this.selectedCategoryId);
      if (category) void this.loadProviders(category);
    }
  }

  ngOnDestroy(): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
  }

  async selectCategory(category: LocalServiceCategory): Promise<void> {
    this.selectedCategoryId = this.selectedCategoryId === category.id ? null : category.id;
    this.selectedProviderId = null;
    this.selectedCategory.set(this.selectedCategoryId ? category : null);
    this.selectedProvider.set(null);
    this.providers.set([]);
    this.recent.set([]);
    this.favourites.set([]);
    this.categoryChange.emit(category);
    this.radiusKm.set(category.searchRadiusKm || 10);
    if (this.selectedCategoryId) {
      await this.loadProviders(category);
    }
  }

  selectProvider(category: LocalServiceCategory, provider: LocalServiceProvider): void {
    const providerId = provider.providerId || (provider.source === 'admin' ? provider.id : null);
    this.selectedProviderId = provider.id;
    this.selectedCategory.set(category);
    this.selectedProvider.set(provider);
    this.sectionExpanded.set(false);
    this.providerChange.emit({
      categoryId: category.id,
      categorySlug: category.categorySlug,
      categoryName: category.categoryName,
      providerId,
      externalPlaceId: provider.externalPlaceId || null,
      providerName: provider.providerName,
      providerLogoUrl: provider.providerLogoUrl || provider.logoUrl,
      providerWebsite: provider.providerWebsite || provider.officialWebsite,
      providerAddress: provider.providerAddress || provider.address,
      providerLatitude: provider.providerLatitude ?? provider.latitude,
      providerLongitude: provider.providerLongitude ?? provider.longitude,
      distanceKm: provider.distanceKm ?? null,
      openStatus: provider.openStatus || null,
      countryCode: this.countryCode,
      serviceSlug: this.serviceSlug,
      source: provider.source || 'catalogue',
      verified: provider.verified === true,
      selectedAt: new Date().toISOString()
    });
  }

  chooseCustom(category: LocalServiceCategory): void {
    this.selectedCategory.set(category);
    this.selectedProvider.set(null);
    this.sectionExpanded.set(false);
    this.customProviderChange.emit({
      categoryId: category.id,
      categorySlug: category.categorySlug,
      categoryName: category.categoryName,
      countryCode: this.countryCode,
      serviceSlug: this.serviceSlug,
      source: 'custom',
      selectedAt: new Date().toISOString()
    });
  }

  setRadius(category: LocalServiceCategory, value: number): void {
    this.radiusKm.set(value);
    void this.loadProviders(category);
  }

  scheduleProviderSearch(category: LocalServiceCategory): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => void this.loadProviders(category), 300);
  }

  clearSearch(category: LocalServiceCategory): void {
    this.searchText = '';
    void this.loadProviders(category);
  }

  toggleSection(): void {
    this.sectionExpanded.update(value => !value);
  }

  selectedTitle(): string {
    return this.selectedProvider()?.providerName || this.selectedCategory()?.categoryName || 'Choose what you need';
  }

  selectedSubtitle(): string {
    const provider = this.selectedProvider();
    if (provider) {
      const distance = provider.distanceKm !== null && provider.distanceKm !== undefined ? ` - ${provider.distanceKm} km away` : '';
      return `${provider.providerAddress || provider.address || 'Selected provider'}${distance}`;
    }

    const category = this.selectedCategory();
    return category?.categoryDescription || 'Pick one local category, then choose a nearby provider';
  }

  selectedIcon(): string {
    return this.resolveCategoryIcon(this.selectedCategory());
  }

  resolveCategoryIcon(category: LocalServiceCategory | null | undefined): string {
    const configured = String(category?.icon || '').trim();
    const allowed = new Set([
      'bag-handle-outline',
      'briefcase-outline',
      'cart-outline',
      'construct-outline',
      'cube-outline',
      'document-text-outline',
      'ellipsis-horizontal-circle-outline',
      'location-outline',
      'medical-outline',
      'person-outline',
      'restaurant-outline',
      'search-outline',
      'shirt-outline',
      'storefront-outline'
    ]);
    if (configured && allowed.has(configured)) return configured;

    const slug = `${category?.categorySlug || ''} ${category?.categoryName || ''}`.toLowerCase();
    if (slug.includes('pharmacy') || slug.includes('medical')) return 'medical-outline';
    if (slug.includes('food') || slug.includes('bakery') || slug.includes('restaurant')) return 'restaurant-outline';
    if (slug.includes('document')) return 'document-text-outline';
    if (slug.includes('parcel') || slug.includes('package') || slug.includes('delivery')) return 'cube-outline';
    if (slug.includes('business')) return 'briefcase-outline';
    if (slug.includes('repair') || slug.includes('service')) return 'construct-outline';
    if (slug.includes('retail') || slug.includes('grocery') || slug.includes('shop')) return 'bag-handle-outline';
    if (String(this.serviceSlug || '').toLowerCase().includes('delivery')) return 'cube-outline';
    return 'storefront-outline';
  }

  hideBrokenImage(event: Event): void {
    const img = event.target as HTMLImageElement | null;
    if (img) img.style.display = 'none';
  }

  private async loadCategories(): Promise<void> {
    this.loading.set(true);
    this.fallbackActive.set(false);
    try {
      const categories = await this.localServices.getCategories(this.countryCode || 'GB', this.serviceSlug || 'errand');
      if (categories.length) {
        this.categories.set(categories);
      } else {
        this.categories.set(this.fallbackCategories());
        this.fallbackActive.set(true);
      }
    } catch (error) {
      console.warn('[LocalServiceSelector] category load failed', error);
      try {
        const categories = await this.localServices.getCategories(this.countryCode || 'GB', this.serviceSlug || 'errand');
        this.categories.set(categories.length ? categories : this.fallbackCategories());
        this.fallbackActive.set(categories.length === 0);
      } catch {
        this.categories.set(this.fallbackCategories());
        this.fallbackActive.set(true);
      }
    } finally {
      this.loading.set(false);
    }
  }

  async loadProviders(category: LocalServiceCategory): Promise<void> {
    this.providersLoading.set(true);
    try {
      const [nearby, recent, favourites] = await Promise.all([
        this.localServices.searchNearby({
          countryCode: this.countryCode || 'GB',
          serviceSlug: this.serviceSlug || 'errand',
          categorySlug: category.categorySlug,
          categoryId: category.id,
          location: this.currentLocation || undefined,
          radiusKm: this.radiusKm(),
          searchText: this.searchText,
          limit: 12
        }),
        this.localServices.getRecent({
          countryCode: this.countryCode || 'GB',
          serviceSlug: this.serviceSlug || 'errand',
          categorySlug: category.categorySlug
        }).catch(() => []),
        this.localServices.getFavourites().catch(() => [])
      ]);
      this.providers.set(nearby);
      this.recent.set(recent);
      this.favourites.set(favourites.filter(item => !category.categorySlug || item.categorySlug === category.categorySlug));
    } catch (error) {
      console.warn('[LocalServiceSelector] provider load failed', error);
      this.providers.set([]);
      this.fallbackActive.set(true);
    } finally {
      this.providersLoading.set(false);
    }
  }

  private fallbackCategories(): LocalServiceCategory[] {
    const service = String(this.serviceSlug || '').toLowerCase();
    const names = service.includes('delivery')
      ? ['Parcel', 'Documents', 'Food', 'Personal item', 'Business delivery', 'Other']
      : ['Grocery', 'Pharmacy', 'Convenience', 'Bakery', 'Retail', 'Other'];

    return names.map((name, index) => ({
      id: `fallback-${service || 'errand'}-${index}`,
      categorySlug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      categoryName: name,
      categoryDescription: index === names.length - 1 ? 'Enter what you need manually' : null,
      icon: this.resolveCategoryIcon({ categorySlug: name, categoryName: name } as LocalServiceCategory),
      searchKeywords: [name],
      fallbackKeywords: [name],
      searchRadiusKm: 10,
      allowCustomProvider: true,
      displayOrder: index
    }));
  }
}

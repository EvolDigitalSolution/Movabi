import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IonicModule, ToastController } from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  addOutline,
  checkmarkCircleOutline,
  closeOutline,
  cloudDownloadOutline,
  createOutline,
  refreshOutline,
  storefrontOutline,
  trashOutline
} from 'ionicons/icons';
import { AppConfigService } from '../../../../core/services/config/app-config.service';
import {
  AdminLocalServiceCategory,
  AdminLocalServiceProvider,
  AdminLocalServicesService
} from '../../services/admin-local-services.service';

type LocalServicesTab = 'categories' | 'providers';

const SERVICES = [
  { label: 'Errand', slug: 'errand' },
  { label: 'Quick Buy', slug: 'quick-buy' },
  { label: 'Shop & Deliver', slug: 'errand' },
  { label: 'Collect & Deliver', slug: 'collect-deliver' },
  { label: 'Delivery', slug: 'delivery' }
];

@Component({
  selector: 'app-admin-local-services',
  standalone: true,
  imports: [CommonModule, FormsModule, IonicModule],
  template: `
    <div class="min-h-screen bg-slate-50 p-4 md:p-6">
      <header class="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <p class="text-xs font-black uppercase tracking-[0.25em] text-orange-600">Marketplace</p>
          <h1 class="text-3xl font-black text-slate-950">Local Services</h1>
          <p class="mt-1 text-sm font-semibold text-slate-500">Manage country-specific categories, providers and logos for customer booking.</p>
        </div>
        <button type="button" class="btn-primary" (click)="reload()">
          <ion-icon name="refresh-outline"></ion-icon>
          Refresh
        </button>
      </header>

      <section class="mb-5 grid gap-3 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm md:grid-cols-4">
        <label class="field">
          <span>Country</span>
          <select [(ngModel)]="countryCode" (ngModelChange)="reload()" class="field-control">
            @for (country of countries(); track country.code) {
              <option [value]="country.code">{{ country.name }} ({{ country.currency }})</option>
            }
          </select>
        </label>
        <label class="field">
          <span>Service</span>
          <select [(ngModel)]="serviceSlug" (ngModelChange)="reload()" class="field-control">
            @for (service of services; track service.label) {
              <option [value]="service.slug">{{ service.label }}</option>
            }
          </select>
        </label>
        <div class="md:col-span-2 flex items-end gap-3">
          <button type="button" [class]="activeTab() === 'categories' ? 'tab active' : 'tab'" (click)="activeTab.set('categories')">Categories</button>
          <button type="button" [class]="activeTab() === 'providers' ? 'tab active' : 'tab'" (click)="activeTab.set('providers')">Providers</button>
        </div>
      </section>

      @if (activeTab() === 'categories') {
        <section class="panel">
          <div class="panel-head">
            <h2>Categories</h2>
            <button type="button" class="btn-primary" (click)="openCategory()">
              <ion-icon name="add-outline"></ion-icon>
              Add Category
            </button>
          </div>
          <div class="overflow-x-auto">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Slug</th>
                  <th>Radius</th>
                  <th>Custom</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                @for (category of categories(); track category.id) {
                  <tr>
                    <td>
                      <strong>{{ category.category_name }}</strong>
                      <span>{{ category.category_description || 'No description' }}</span>
                    </td>
                    <td>{{ category.category_slug }}</td>
                    <td>{{ category.default_search_radius_km || 10 }} km</td>
                    <td>{{ category.allow_custom_provider === false ? 'No' : 'Yes' }}</td>
                    <td><span [class]="category.enabled === false ? 'badge off' : 'badge'">{{ category.enabled === false ? 'Disabled' : 'Enabled' }}</span></td>
                    <td class="actions">
                      <button type="button" (click)="openCategory(category)" aria-label="Edit category"><ion-icon name="create-outline"></ion-icon></button>
                      <button type="button" (click)="disableCategory(category)" aria-label="Disable category"><ion-icon name="trash-outline"></ion-icon></button>
                    </td>
                  </tr>
                } @empty {
                  <tr><td colspan="6" class="empty">No categories configured.</td></tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      } @else {
        <section class="panel">
          <div class="panel-head">
            <h2>Providers</h2>
            <button type="button" class="btn-primary" (click)="openProvider()" [disabled]="!categories().length">
              <ion-icon name="add-outline"></ion-icon>
              Add Provider
            </button>
          </div>
          <div class="external-search">
            <div>
              <h3>Find nearby businesses</h3>
              <p>Search configured providers, cache and live provider results, then import approved places.</p>
            </div>
            <label class="field">
              <span>Search</span>
              <input class="field-control" [(ngModel)]="externalSearchText" name="external_search" placeholder="Asda, McDonald's, pharmacy">
            </label>
            <label class="field">
              <span>Category</span>
              <select class="field-control" [(ngModel)]="externalCategoryId" name="external_category">
                @for (category of categories(); track category.id) {
                  <option [value]="category.id">{{ category.category_name }}</option>
                }
              </select>
            </label>
            <label class="field">
              <span>Radius km</span>
              <input type="number" class="field-control" [(ngModel)]="externalRadiusKm" name="external_radius">
            </label>
            <button type="button" class="btn-primary" (click)="searchExternalProviders()" [disabled]="externalLoading() || !externalCategoryId">
              <ion-icon name="cloud-download-outline"></ion-icon>
              {{ externalLoading() ? 'Searching...' : 'Search External' }}
            </button>
          </div>
          @if (externalResults().length) {
            <div class="external-results">
              @for (result of externalResults(); track result.external_place_id || result.id || result.provider_name) {
                <article class="external-card">
                  <div class="provider-logo">
                    @if (result.logo_url) {
                      <img [src]="result.logo_url" alt="">
                    } @else {
                      <ion-icon name="storefront-outline"></ion-icon>
                    }
                  </div>
                  <div>
                    <strong>{{ result.provider_name }}</strong>
                    <span>{{ result.address || result.official_website || 'No address yet' }}</span>
                  </div>
                  <button type="button" class="btn-ghost" (click)="importExternalProvider(result)">
                    Import
                  </button>
                </article>
              }
            </div>
          }
          <div class="overflow-x-auto">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Category</th>
                  <th>Address</th>
                  <th>Verified</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                @for (provider of providers(); track provider.id) {
                  <tr>
                    <td>
                      <div class="provider-cell">
                        @if (provider.logo_url) {
                          <img [src]="provider.logo_url" alt="">
                        } @else {
                          <ion-icon name="storefront-outline"></ion-icon>
                        }
                        <span>
                          <strong>{{ provider.provider_name }}</strong>
                          <span>{{ provider.provider_slug }}</span>
                        </span>
                      </div>
                    </td>
                    <td>{{ provider.category?.category_name || categoryName(provider.category_id) }}</td>
                    <td>{{ provider.address || 'No address' }}</td>
                    <td>{{ provider.verified ? 'Yes' : 'No' }}</td>
                    <td><span [class]="provider.enabled === false ? 'badge off' : 'badge'">{{ provider.enabled === false ? 'Disabled' : 'Enabled' }}</span></td>
                    <td class="actions">
                      <button type="button" (click)="resolveProviderBrand(provider)" aria-label="Resolve provider logo"><ion-icon name="cloud-download-outline"></ion-icon></button>
                      <button type="button" (click)="verifyProvider(provider)" aria-label="Verify provider"><ion-icon name="checkmark-circle-outline"></ion-icon></button>
                      <button type="button" (click)="openProvider(provider)" aria-label="Edit provider"><ion-icon name="create-outline"></ion-icon></button>
                      <button type="button" (click)="disableProvider(provider)" aria-label="Disable provider"><ion-icon name="trash-outline"></ion-icon></button>
                    </td>
                  </tr>
                } @empty {
                  <tr><td colspan="6" class="empty">No providers configured.</td></tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      }
    </div>

    @if (categoryDraft()) {
      <div class="modal-backdrop">
        <form class="modal-card" (ngSubmit)="saveCategory()">
          <header>
            <h2>{{ categoryDraft()?.id ? 'Edit' : 'Add' }} Category</h2>
            <button type="button" (click)="categoryDraft.set(null)" aria-label="Close"><ion-icon name="close-outline"></ion-icon></button>
          </header>
          <div class="modal-body grid gap-4 md:grid-cols-2">
            <label class="field"><span>Name</span><input class="field-control" [(ngModel)]="categoryDraft()!.category_name" name="category_name" required></label>
            <label class="field"><span>Slug</span><input class="field-control" [(ngModel)]="categoryDraft()!.category_slug" name="category_slug" required></label>
            <label class="field"><span>Icon</span><input class="field-control" [(ngModel)]="categoryDraft()!.icon" name="icon" placeholder="basket-outline"></label>
            <label class="field"><span>Search radius km</span><input type="number" class="field-control" [(ngModel)]="categoryDraft()!.default_search_radius_km" name="radius"></label>
            <label class="field md:col-span-2"><span>Description</span><textarea class="field-control" [(ngModel)]="categoryDraft()!.category_description" name="description"></textarea></label>
            <label class="field md:col-span-2"><span>Keywords</span><input class="field-control" [ngModel]="keywordsText(categoryDraft()?.search_keywords)" (ngModelChange)="setCategoryKeywords($event)" name="keywords"></label>
            <label class="field"><span>Provider types</span><input class="field-control" [ngModel]="keywordsText(categoryDraft()?.provider_types)" (ngModelChange)="setCategoryProviderTypes($event)" name="provider_types" placeholder="supermarket, pharmacy"></label>
            <label class="field"><span>Fallback keywords</span><input class="field-control" [ngModel]="keywordsText(categoryDraft()?.fallback_keywords)" (ngModelChange)="setCategoryFallbackKeywords($event)" name="fallback_keywords" placeholder="shop, groceries"></label>
            <label class="check"><input type="checkbox" [(ngModel)]="categoryDraft()!.allow_custom_provider" name="allow_custom"> Allow custom provider</label>
            <label class="check"><input type="checkbox" [(ngModel)]="categoryDraft()!.enabled" name="enabled"> Enabled</label>
            <label class="field"><span>Display order</span><input type="number" class="field-control" [(ngModel)]="categoryDraft()!.display_order" name="display_order"></label>
          </div>
          <footer>
            <button type="button" class="btn-ghost" (click)="categoryDraft.set(null)">Cancel</button>
            <button type="submit" class="btn-primary">Save</button>
          </footer>
        </form>
      </div>
    }

    @if (providerDraft()) {
      <div class="modal-backdrop">
        <form class="modal-card" (ngSubmit)="saveProvider()">
          <header>
            <h2>{{ providerDraft()?.id ? 'Edit' : 'Add' }} Provider</h2>
            <button type="button" (click)="providerDraft.set(null)" aria-label="Close"><ion-icon name="close-outline"></ion-icon></button>
          </header>
          <div class="modal-body grid gap-4 md:grid-cols-2">
            <label class="field"><span>Category</span><select class="field-control" [(ngModel)]="providerDraft()!.category_id" name="category_id" required>@for (category of categories(); track category.id) {<option [value]="category.id">{{ category.category_name }}</option>}</select></label>
            <label class="field"><span>Provider name</span><input class="field-control" [(ngModel)]="providerDraft()!.provider_name" name="provider_name" required></label>
            <label class="field"><span>Slug</span><input class="field-control" [(ngModel)]="providerDraft()!.provider_slug" name="provider_slug" required></label>
            <label class="field"><span>Logo URL</span><input class="field-control" [(ngModel)]="providerDraft()!.logo_url" name="logo_url" placeholder="https://..."></label>
            <label class="field"><span>Official website</span><input class="field-control" [(ngModel)]="providerDraft()!.official_website" name="website" placeholder="https://..."></label>
            <label class="field"><span>Address</span><input class="field-control" [(ngModel)]="providerDraft()!.address" name="address"></label>
            <label class="field"><span>Latitude</span><input type="number" step="any" class="field-control" [(ngModel)]="providerDraft()!.latitude" name="lat"></label>
            <label class="field"><span>Longitude</span><input type="number" step="any" class="field-control" [(ngModel)]="providerDraft()!.longitude" name="lng"></label>
            <label class="field md:col-span-2"><span>Keywords</span><input class="field-control" [ngModel]="keywordsText(providerDraft()?.search_keywords)" (ngModelChange)="setProviderKeywords($event)" name="provider_keywords"></label>
            <label class="check"><input type="checkbox" [(ngModel)]="providerDraft()!.verified" name="verified"> Verified</label>
            <label class="check"><input type="checkbox" [(ngModel)]="providerDraft()!.enabled" name="provider_enabled"> Enabled</label>
            <label class="field"><span>Display order</span><input type="number" class="field-control" [(ngModel)]="providerDraft()!.display_order" name="provider_order"></label>
          </div>
          <footer>
            <button type="button" class="btn-ghost" (click)="providerDraft.set(null)">Cancel</button>
            <button type="submit" class="btn-primary">Save</button>
          </footer>
        </form>
      </div>
    }
  `,
  styles: [`
    .panel { border: 1px solid #e2e8f0; border-radius: 24px; background: white; box-shadow: 0 18px 45px rgba(15, 23, 42, .08); overflow: hidden; }
    .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px; border-bottom: 1px solid #e2e8f0; }
    .panel-head h2 { margin: 0; font-size: 18px; font-weight: 900; color: #0f172a; }
    .btn-primary, .btn-ghost, .tab { min-height: 44px; border-radius: 14px; padding: 0 16px; font-weight: 900; display: inline-flex; align-items: center; justify-content: center; gap: 8px; }
    .btn-primary { background: #ff9900; color: #111827; border: 0; box-shadow: 0 10px 24px rgba(255, 153, 0, .22); }
    .btn-primary:disabled { opacity: .45; box-shadow: none; }
    .btn-ghost, .tab { border: 1px solid #e2e8f0; background: white; color: #334155; }
    .tab.active { background: #111827; color: white; }
    .field { display: grid; gap: 6px; font-size: 12px; font-weight: 900; text-transform: uppercase; letter-spacing: .08em; color: #64748b; }
    .field-control { min-height: 44px; border: 1px solid #cbd5e1; border-radius: 14px; padding: 10px 12px; background: white; color: #0f172a; font-size: 14px; font-weight: 700; text-transform: none; letter-spacing: 0; }
    .check { min-height: 44px; display: flex; align-items: center; gap: 10px; font-weight: 800; color: #334155; }
    .data-table { width: 100%; border-collapse: collapse; }
    .data-table th { text-align: left; padding: 12px 16px; font-size: 11px; text-transform: uppercase; letter-spacing: .12em; color: #64748b; background: #f8fafc; }
    .data-table td { padding: 14px 16px; border-top: 1px solid #e2e8f0; color: #334155; font-weight: 700; vertical-align: top; }
    .data-table strong, .data-table span { display: block; }
    .data-table strong { color: #0f172a; }
    .data-table span { font-size: 12px; color: #64748b; margin-top: 2px; }
    .provider-cell { display: grid; grid-template-columns: 44px 1fr; gap: 10px; align-items: center; }
    .provider-cell img, .provider-logo img { width: 44px; height: 44px; border-radius: 12px; object-fit: contain; background: #f8fafc; border: 1px solid #e2e8f0; padding: 4px; }
    .provider-cell > ion-icon, .provider-logo ion-icon { width: 44px; height: 44px; border-radius: 12px; padding: 10px; background: #fff7ed; color: #ea580c; border: 1px solid #fed7aa; }
    .actions { text-align: right; white-space: nowrap; }
    .actions button { width: 38px; height: 38px; border-radius: 12px; border: 1px solid #e2e8f0; background: white; margin-left: 6px; }
    .badge { display: inline-flex; border-radius: 999px; padding: 6px 10px; background: #dcfce7; color: #047857; font-size: 11px; font-weight: 900; }
    .badge.off { background: #fee2e2; color: #b91c1c; }
    .empty { text-align: center; color: #64748b; padding: 28px !important; }
    .modal-backdrop { position: fixed; inset: 0; z-index: 60; background: rgba(15,23,42,.55); display: grid; place-items: center; padding: 16px; }
    .modal-card { width: min(860px, 100%); max-height: 90vh; background: white; border-radius: 24px; overflow: hidden; display: grid; grid-template-rows: auto 1fr auto; }
    .modal-card header, .modal-card footer { position: sticky; background: white; z-index: 1; padding: 16px 20px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .modal-card header { top: 0; border-bottom: 1px solid #e2e8f0; }
    .modal-card footer { bottom: 0; border-top: 1px solid #e2e8f0; justify-content: flex-end; }
    .modal-card h2 { margin: 0; font-size: 20px; font-weight: 900; color: #0f172a; }
    .modal-card header button { width: 44px; height: 44px; border-radius: 14px; border: 1px solid #e2e8f0; background: #f8fafc; }
    .modal-body { overflow-y: auto; padding: 20px; }
    .external-search { display: grid; gap: 12px; grid-template-columns: 1.4fr 1fr 1fr .7fr auto; align-items: end; padding: 16px; border-bottom: 1px solid #e2e8f0; background: #fff7ed; }
    .external-search h3 { margin: 0; font-size: 16px; font-weight: 900; color: #0f172a; }
    .external-search p { margin: 4px 0 0; font-size: 12px; font-weight: 700; color: #64748b; }
    .external-results { display: grid; gap: 10px; padding: 14px 16px; border-bottom: 1px solid #e2e8f0; background: #f8fafc; }
    .external-card { display: grid; grid-template-columns: 48px 1fr auto; gap: 12px; align-items: center; border: 1px solid #e2e8f0; border-radius: 16px; background: white; padding: 10px; }
    .external-card strong, .external-card span { display: block; }
    .external-card strong { color: #0f172a; font-weight: 900; }
    .external-card span { color: #64748b; font-size: 12px; font-weight: 700; }
    @media (max-width: 900px) {
      .external-search { grid-template-columns: 1fr; }
    }
  `]
})
export class AdminLocalServicesComponent implements OnInit {
  private service = inject(AdminLocalServicesService);
  private appConfig = inject(AppConfigService);
  private toastCtrl = inject(ToastController);

  services = SERVICES;
  activeTab = signal<LocalServicesTab>('categories');
  countries = this.appConfig.countries;
  countryCode = this.appConfig.currentCountry()?.code || 'GB';
  serviceSlug = 'errand';
  categories = signal<AdminLocalServiceCategory[]>([]);
  providers = signal<AdminLocalServiceProvider[]>([]);
  categoryDraft = signal<AdminLocalServiceCategory | null>(null);
  providerDraft = signal<AdminLocalServiceProvider | null>(null);
  externalResults = signal<AdminLocalServiceProvider[]>([]);
  externalLoading = signal(false);
  externalSearchText = '';
  externalCategoryId = '';
  externalRadiusKm = 10;
  selectedCountry = computed(() => this.countries().find(country => country.code === this.countryCode));

  constructor() {
    addIcons({ addOutline, checkmarkCircleOutline, closeOutline, cloudDownloadOutline, createOutline, refreshOutline, storefrontOutline, trashOutline });
  }

  ngOnInit(): void {
    void this.reload();
  }

  async reload(): Promise<void> {
    try {
      const [categories, providers] = await Promise.all([
        this.service.getCategories({ countryCode: this.countryCode, serviceSlug: this.serviceSlug }),
        this.service.getProviders({ countryCode: this.countryCode })
      ]);
      this.categories.set(categories);
      this.providers.set(providers.filter(provider => categories.some(category => category.id === provider.category_id)));
      if (!this.externalCategoryId || !categories.some(category => category.id === this.externalCategoryId)) {
        this.externalCategoryId = categories[0]?.id || '';
      }
    } catch (error) {
      await this.showToast(error instanceof Error ? error.message : 'Failed to load local services.', 'danger');
    }
  }

  openCategory(category?: AdminLocalServiceCategory): void {
    this.categoryDraft.set(category ? { ...category } : {
      country_code: this.countryCode,
      service_slug: this.serviceSlug,
      category_slug: '',
      category_name: '',
      category_description: '',
      icon: 'storefront-outline',
      search_keywords: [],
      provider_types: [],
      fallback_keywords: [],
      default_search_radius_km: 10,
      allow_custom_provider: true,
      display_order: this.categories().length + 1,
      enabled: true
    });
  }

  openProvider(provider?: AdminLocalServiceProvider): void {
    const firstCategory = this.categories()[0];
    this.providerDraft.set(provider ? { ...provider } : {
      country_code: this.countryCode,
      category_id: firstCategory?.id || '',
      provider_name: '',
      provider_slug: '',
      provider_description: '',
      logo_url: '',
      official_website: '',
      search_keywords: [],
      address: '',
      latitude: null,
      longitude: null,
      source: 'admin',
      verified: false,
      enabled: true,
      display_order: this.providers().length + 1
    });
  }

  async saveCategory(): Promise<void> {
    const draft = this.categoryDraft();
    if (!draft) return;
    try {
      draft.country_code = this.countryCode;
      draft.service_slug = this.serviceSlug;
      await this.service.saveCategory(draft);
      this.categoryDraft.set(null);
      await this.reload();
      await this.showToast('Category saved.', 'success');
    } catch (error) {
      await this.showToast(error instanceof Error ? error.message : 'Failed to save category.', 'danger');
    }
  }

  async saveProvider(): Promise<void> {
    const draft = this.providerDraft();
    if (!draft) return;
    try {
      draft.country_code = this.countryCode;
      await this.service.saveProvider(draft);
      this.providerDraft.set(null);
      await this.reload();
      await this.showToast('Provider saved.', 'success');
    } catch (error) {
      await this.showToast(error instanceof Error ? error.message : 'Failed to save provider.', 'danger');
    }
  }

  async disableCategory(category: AdminLocalServiceCategory): Promise<void> {
    if (!category.id) return;
    await this.service.disableCategory(category.id);
    await this.reload();
  }

  async disableProvider(provider: AdminLocalServiceProvider): Promise<void> {
    if (!provider.id) return;
    await this.service.disableProvider(provider.id);
    await this.reload();
  }

  async searchExternalProviders(): Promise<void> {
    const category = this.categories().find(item => item.id === this.externalCategoryId);
    if (!category) return;
    this.externalLoading.set(true);
    try {
      const providers = await this.service.searchExternalProviders({
        countryCode: this.countryCode,
        serviceSlug: this.serviceSlug,
        categorySlug: category.category_slug,
        categoryId: category.id,
        q: this.externalSearchText,
        radiusKm: this.externalRadiusKm,
        limit: 12
      });
      this.externalResults.set(providers.map(provider => ({ ...provider, category_id: category.id || provider.category_id, country_code: this.countryCode })));
      if (!providers.length) await this.showToast('No external providers found. Try wider keywords or radius.', 'danger');
    } catch (error) {
      await this.showToast(error instanceof Error ? error.message : 'External provider search failed.', 'danger');
    } finally {
      this.externalLoading.set(false);
    }
  }

  async importExternalProvider(provider: AdminLocalServiceProvider): Promise<void> {
    const categoryId = this.externalCategoryId || provider.category_id;
    if (!categoryId) return;
    try {
      await this.service.importProvider({
        ...provider,
        country_code: this.countryCode,
        category_id: categoryId,
        provider_slug: provider.provider_slug || this.slugify(provider.provider_name),
        verified: provider.verified === true,
        enabled: true
      });
      this.externalResults.set(this.externalResults().filter(item => item !== provider));
      await this.reload();
      await this.showToast('Provider imported.', 'success');
    } catch (error) {
      await this.showToast(error instanceof Error ? error.message : 'Failed to import provider.', 'danger');
    }
  }

  async resolveProviderBrand(provider: AdminLocalServiceProvider): Promise<void> {
    if (!provider.id) return;
    try {
      await this.service.resolveProviderBrand(provider.id);
      await this.reload();
      await this.showToast('Provider brand checked.', 'success');
    } catch (error) {
      await this.showToast(error instanceof Error ? error.message : 'Failed to resolve brand.', 'danger');
    }
  }

  async verifyProvider(provider: AdminLocalServiceProvider): Promise<void> {
    if (!provider.id) return;
    try {
      await this.service.verifyProvider(provider.id, !provider.verified);
      await this.reload();
      await this.showToast(provider.verified ? 'Provider unverified.' : 'Provider verified.', 'success');
    } catch (error) {
      await this.showToast(error instanceof Error ? error.message : 'Failed to update provider verification.', 'danger');
    }
  }

  categoryName(categoryId: string): string {
    return this.categories().find(category => category.id === categoryId)?.category_name || 'Category';
  }

  keywordsText(value?: string[]): string {
    return (value || []).join(', ');
  }

  setCategoryKeywords(value: string): void {
    const draft = this.categoryDraft();
    if (draft) draft.search_keywords = this.splitKeywords(value);
  }

  setCategoryProviderTypes(value: string): void {
    const draft = this.categoryDraft();
    if (draft) draft.provider_types = this.splitKeywords(value);
  }

  setCategoryFallbackKeywords(value: string): void {
    const draft = this.categoryDraft();
    if (draft) draft.fallback_keywords = this.splitKeywords(value);
  }

  setProviderKeywords(value: string): void {
    const draft = this.providerDraft();
    if (draft) draft.search_keywords = this.splitKeywords(value);
  }

  private splitKeywords(value: string): string[] {
    return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
  }

  private slugify(value: string): string {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  private async showToast(message: string, color: 'success' | 'danger'): Promise<void> {
    const toast = await this.toastCtrl.create({ message, color, duration: 2500 });
    await toast.present();
  }
}

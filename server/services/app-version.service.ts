import { supabaseAdmin } from './supabase.service';

export type AppUpdateSeverity = 'optional' | 'recommended' | 'required' | 'critical';
export type AppPlatform = 'web' | 'android' | 'ios';

export interface AppVersionConfig {
  current_web_version: string;
  minimum_web_version: string;
  current_android_version: string;
  minimum_android_version: string;
  current_ios_version: string;
  minimum_ios_version: string;
  update_required: boolean;
  update_severity: AppUpdateSeverity;
  update_title: string;
  update_message: string;
  release_notes: string;
  android_update_url: string;
  ios_update_url: string;
  web_reload_required: boolean;
  admin_set_by?: string | null;
  updated_at?: string | null;
}

export const DEFAULT_APP_VERSION_CONFIG: AppVersionConfig = {
  current_web_version: process.env.APP_VERSION || '1.0.0',
  minimum_web_version: process.env.MINIMUM_WEB_VERSION || '1.0.0',
  current_android_version: process.env.APP_VERSION || '1.0.0',
  minimum_android_version: process.env.MINIMUM_ANDROID_VERSION || '1.0.0',
  current_ios_version: process.env.APP_VERSION || '1.0.0',
  minimum_ios_version: process.env.MINIMUM_IOS_VERSION || '1.0.0',
  update_required: false,
  update_severity: 'optional',
  update_title: 'Movabi update available',
  update_message: 'A new version of Movabi is available.',
  release_notes: '',
  android_update_url: process.env.ANDROID_UPDATE_URL || '',
  ios_update_url: process.env.IOS_UPDATE_URL || '',
  web_reload_required: false,
  admin_set_by: null,
  updated_at: null
};

function normaliseSeverity(value: unknown): AppUpdateSeverity {
  const severity = String(value || '').trim().toLowerCase();
  return ['optional', 'recommended', 'required', 'critical'].includes(severity)
    ? severity as AppUpdateSeverity
    : 'optional';
}

function cleanVersion(value: unknown, fallback: string): string {
  const version = String(value || '').trim();
  return version || fallback;
}

export function normaliseAppVersionConfig(value: unknown): AppVersionConfig {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};

  return {
    current_web_version: cleanVersion(source.current_web_version ?? source.currentWebVersion, DEFAULT_APP_VERSION_CONFIG.current_web_version),
    minimum_web_version: cleanVersion(source.minimum_web_version ?? source.minimumWebVersion, DEFAULT_APP_VERSION_CONFIG.minimum_web_version),
    current_android_version: cleanVersion(source.current_android_version ?? source.currentAndroidVersion, DEFAULT_APP_VERSION_CONFIG.current_android_version),
    minimum_android_version: cleanVersion(source.minimum_android_version ?? source.minimumAndroidVersion, DEFAULT_APP_VERSION_CONFIG.minimum_android_version),
    current_ios_version: cleanVersion(source.current_ios_version ?? source.currentIosVersion, DEFAULT_APP_VERSION_CONFIG.current_ios_version),
    minimum_ios_version: cleanVersion(source.minimum_ios_version ?? source.minimumIosVersion, DEFAULT_APP_VERSION_CONFIG.minimum_ios_version),
    update_required: Boolean(source.update_required ?? source.updateRequired ?? DEFAULT_APP_VERSION_CONFIG.update_required),
    update_severity: normaliseSeverity(source.update_severity ?? source.updateSeverity ?? DEFAULT_APP_VERSION_CONFIG.update_severity),
    update_title: String(source.update_title ?? source.updateTitle ?? DEFAULT_APP_VERSION_CONFIG.update_title).trim() || DEFAULT_APP_VERSION_CONFIG.update_title,
    update_message: String(source.update_message ?? source.updateMessage ?? DEFAULT_APP_VERSION_CONFIG.update_message).trim() || DEFAULT_APP_VERSION_CONFIG.update_message,
    release_notes: String(source.release_notes ?? source.releaseNotes ?? DEFAULT_APP_VERSION_CONFIG.release_notes).trim(),
    android_update_url: String(source.android_update_url ?? source.androidUpdateUrl ?? DEFAULT_APP_VERSION_CONFIG.android_update_url).trim(),
    ios_update_url: String(source.ios_update_url ?? source.iosUpdateUrl ?? DEFAULT_APP_VERSION_CONFIG.ios_update_url).trim(),
    web_reload_required: Boolean(source.web_reload_required ?? source.webReloadRequired ?? DEFAULT_APP_VERSION_CONFIG.web_reload_required),
    admin_set_by: typeof source.admin_set_by === 'string' ? source.admin_set_by : typeof source.adminSetBy === 'string' ? source.adminSetBy : null,
    updated_at: typeof source.updated_at === 'string' ? source.updated_at : typeof source.updatedAt === 'string' ? source.updatedAt : null
  };
}

export function compareSemanticVersions(left: string, right: string): number {
  const parse = (version: string) => String(version || '0')
    .replace(/^[^\d]*/, '')
    .split(/[.-]/)
    .slice(0, 4)
    .map(part => {
      const match = part.match(/\d+/);
      return match ? Number(match[0]) : 0;
    });

  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.length, b.length, 3);

  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }

  return 0;
}

export function normalisePlatform(value: unknown): AppPlatform {
  const platform = String(value || '').trim().toLowerCase();
  return platform === 'android' || platform === 'ios' ? platform : 'web';
}

export function versionFieldsForPlatform(config: AppVersionConfig, platform: AppPlatform) {
  if (platform === 'android') {
    return {
      currentVersion: config.current_android_version,
      minimumVersion: config.minimum_android_version,
      updateUrl: config.android_update_url
    };
  }

  if (platform === 'ios') {
    return {
      currentVersion: config.current_ios_version,
      minimumVersion: config.minimum_ios_version,
      updateUrl: config.ios_update_url
    };
  }

  return {
    currentVersion: config.current_web_version,
    minimumVersion: config.minimum_web_version,
    updateUrl: ''
  };
}

export class AppVersionService {
  static async getConfig(): Promise<AppVersionConfig> {
    try {
      const { data, error } = await supabaseAdmin
        .from('system_configs')
        .select('value')
        .eq('key', 'app_version_config')
        .maybeSingle();

      if (error) {
        console.warn('[AppVersion] config read failed; using defaults:', error.message);
        return DEFAULT_APP_VERSION_CONFIG;
      }

      return normaliseAppVersionConfig(data?.value || DEFAULT_APP_VERSION_CONFIG);
    } catch (error: any) {
      console.warn('[AppVersion] config read failed; using defaults:', error?.message || error);
      return DEFAULT_APP_VERSION_CONFIG;
    }
  }

  static async saveConfig(config: AppVersionConfig): Promise<AppVersionConfig> {
    const normalised = normaliseAppVersionConfig(config);
    const value = {
      ...normalised,
      updated_at: new Date().toISOString()
    };

    const { error } = await supabaseAdmin
      .from('system_configs')
      .upsert({ key: 'app_version_config', value, updated_at: value.updated_at }, { onConflict: 'key' });

    if (error) {
      throw new Error(error.message);
    }

    return value;
  }
}

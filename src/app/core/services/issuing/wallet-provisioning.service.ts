import { Injectable } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';

export interface WalletProvisioningAvailability {
  available: boolean;
  platform: 'ios' | 'android' | 'web' | string;
  walletName: 'Apple Pay' | 'Google Wallet' | 'Phone Wallet';
  reason?: string;
}

export interface WalletProvisioningRequest {
  cardId: string;
  cardholderId?: string | null;
  last4?: string | null;
  displayName?: string;
  description?: string;
  currency?: string;
  spendLimit?: number;
}

export interface WalletProvisioningResult {
  success: boolean;
  walletName?: string;
  message?: string;
}

interface MovabiWalletProvisioningPlugin {
  isAvailable(options?: Partial<WalletProvisioningRequest>): Promise<WalletProvisioningAvailability>;
  provisionCard(options: WalletProvisioningRequest): Promise<WalletProvisioningResult>;
}

const NativeWalletProvisioning = registerPlugin<MovabiWalletProvisioningPlugin>('MovabiWalletProvisioning');

@Injectable({ providedIn: 'root' })
export class WalletProvisioningService {
  getWalletName(): 'Apple Pay' | 'Google Wallet' | 'Phone Wallet' {
    const platform = Capacitor.getPlatform();

    if (platform === 'ios') return 'Apple Pay';
    if (platform === 'android') return 'Google Wallet';
    return 'Phone Wallet';
  }

  async checkAvailability(card?: Partial<WalletProvisioningRequest>): Promise<WalletProvisioningAvailability> {
    const platform = Capacitor.getPlatform();
    const walletName = this.getWalletName();

    if (!Capacitor.isNativePlatform()) {
      return {
        available: false,
        platform,
        walletName,
        reason: 'Phone wallet setup is available in the installed iOS or Android app.'
      };
    }

    try {
      return await NativeWalletProvisioning.isAvailable(card);
    } catch {
      return {
        available: false,
        platform,
        walletName,
        reason: `${walletName} provisioning is not enabled in this app build yet.`
      };
    }
  }

  async provisionCard(request: WalletProvisioningRequest): Promise<WalletProvisioningResult> {
    const availability = await this.checkAvailability(request);

    if (!availability.available) {
      return {
        success: false,
        walletName: availability.walletName,
        message: availability.reason || `${availability.walletName} is not available on this device.`
      };
    }

    try {
      const result = await NativeWalletProvisioning.provisionCard({
        ...request,
        displayName: request.displayName || 'Movabi Pay',
        description: request.description || 'Movabi Pay virtual card'
      });

      return {
        walletName: availability.walletName,
        ...result
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : `Could not add card to ${availability.walletName}.`;

      return {
        success: false,
        walletName: availability.walletName,
        message
      };
    }
  }
}

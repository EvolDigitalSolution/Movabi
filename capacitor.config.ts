import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.movabi.app',
  appName: 'Movabi',
  webDir: 'dist/mobile/browser',
  server: {
    androidScheme: 'https'
  }
};

export default config;

import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.movabi.app',
  appName: 'Movabi',
  webDir: 'dist/mobile/browser',
  server: {
    androidScheme: 'https'
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1400,
      launchAutoHide: true,
      backgroundColor: '#F8FAFC',
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_INSIDE',
      showSpinner: false,
      splashFullScreen: false,
      splashImmersive: false
    },
    Keyboard: {
      resize: 'body',
      style: 'light',
      resizeOnFullScreen: true
    },
    StatusBar: {
      style: 'LIGHT',
      backgroundColor: '#F8FAFC',
      overlaysWebView: false
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert']
    },
    LocalNotifications: {
      smallIcon: 'ic_stat_movabi',
      iconColor: '#F59E0B'
    },
    OneSignal: {
      appId: '952c6d19-656c-4dab-90f3-6e253e2c9151'
    }
  }
};

export default config;

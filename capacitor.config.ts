import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.stocker.sim',
  appName: 'Stocker',
  webDir: 'dist',
  backgroundColor: '#0b1020',
  plugins: {
    // Route fetch/XHR through the native HTTP stack so keyless Yahoo Finance
    // (no CORS headers) works in the APK. Off in plain browsers, where the app
    // reports a typed CORS error instead.
    CapacitorHttp: { enabled: true },
  },
};

export default config;

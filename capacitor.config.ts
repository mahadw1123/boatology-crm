import type { CapacitorConfig } from '@capacitor/cli';

// IMPORTANT: This app has a live backend (database, auth, Xero, email).
// It is NOT a static app, so the iOS shell must point at your real,
// deployed website — not bundle the code locally on the phone.
//
// Before building for iOS:
// 1. Deploy the app to a real host (e.g. Railway) so it has a public
//    https:// URL, per the hosting plan discussed earlier.
// 2. Replace YOUR_DEPLOYED_URL below with that real URL.
// 3. Run `npm run build` then `npx cap sync ios` to apply this config.

const config: CapacitorConfig = {
  appId: 'com.boatologymarine.app',
  appName: 'Boatology',
  webDir: 'dist',
  server: {
    // Replace with your real deployed URL, e.g. "https://boatology.up.railway.app"
    url: 'https://YOUR_DEPLOYED_URL_HERE',
    cleartext: false,
  },
};

export default config;

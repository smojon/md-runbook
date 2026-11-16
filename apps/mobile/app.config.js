/**
 * Expo reads app.json, then this: push notifications from the team library server go into a
 * build only when it has what they need, so CI and builds without the owner's accounts still
 * work (the app then says "Not set up in this build"). docs/push-and-testflight.md.
 *
 * - Android: Firebase's google-services.json, at GOOGLE_SERVICES_JSON (a path) or next to this
 *   file. Expo then adds the Google services Gradle plugin.
 * - iOS: MD_RUNBOOK_IOS_PUSH=1 adds the APNs entitlement (aps-environment). Only for builds signed
 *   with a profile that has Push Notifications: other signing fails with it.
 * - MD_RUNBOOK_IOS_BUILD_NUMBER: CFBundleVersion (TestFlight wants a new one per upload).
 */
/* global __dirname */
const fs = require('node:fs');
const path = require('node:path');

module.exports = ({ config }) => {
  const envFile = process.env.GOOGLE_SERVICES_JSON;
  const localFile = path.join(__dirname, 'google-services.json');
  const googleServicesFile = envFile && fs.existsSync(envFile) ? envFile : fs.existsSync(localFile) ? './google-services.json' : undefined;
  const iosPush = /^(1|true|yes)$/i.test(process.env.MD_RUNBOOK_IOS_PUSH ?? '');
  const buildNumber = process.env.MD_RUNBOOK_IOS_BUILD_NUMBER;
  if (buildNumber !== undefined && !/^\d{1,9}(\.\d{1,9}){0,2}$/.test(buildNumber))
    throw new Error(`MD_RUNBOOK_IOS_BUILD_NUMBER must be like 42 or 1.0.42, got ${JSON.stringify(buildNumber)}`);
  const plugins = (config.plugins ?? []).map((p) =>
    Array.isArray(p) && p[0] === 'expo-notifications' ? ['expo-notifications', { ...p[1], enableRemoteNotifications: iosPush }] : p,
  );
  return {
    ...config,
    plugins,
    ios: { ...config.ios, ...(buildNumber ? { buildNumber } : {}) },
    android: { ...config.android, ...(googleServicesFile ? { googleServicesFile } : {}) },
    // What alertPush.ts reads (expo-constants): whether this build can register for pushes.
    extra: { ...config.extra, push: { android: googleServicesFile !== undefined, ios: iosPush } },
  };
};

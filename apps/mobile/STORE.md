# Releasing the app to the stores

The builds run on EAS (Expo's build service) from `eas.json`. Build numbers are kept by EAS
(`appVersionSource: remote`) and go up by one on every production build. The version people
see is `version` in `app.json`.

## What only the owner can do

These need your accounts, and some cost money. Nothing here has been done yet.

1. **Expo account.** Run `npx eas login`, then `npx eas init` in `apps/mobile`. This adds the
   project ID to `app.json`; commit that change.
2. **Apple Developer Program** (99 USD a year). Create the app in App Store Connect with the
   bundle ID `dev.mdrunbook.app`. EAS creates the signing certificate and profile on the first
   iOS build when you sign in with your Apple ID.
3. **Google Play Console** (25 USD once). Create the app with the package `dev.mdrunbook.app`.
   Google requires the first upload by hand: download the first `.aab` from EAS and upload it
   to the internal testing track. Later uploads can go through `eas submit` with a service
   account key.
4. **Encryption export compliance.** The app encrypts its SSH connections with OpenSSL (through
   react-native-quick-crypto). App Store Connect asks about this on every upload unless
   `ios.config.usesNonExemptEncryption` is set in `app.json`. Which answer is right is a legal
   question for you: SSH is standard encryption, but it is not only Apple's own.
5. **Store listing.** You need a description, screenshots (the device flows in CI save some),
   a privacy policy URL and the privacy questionnaires. The app sends no analytics. It only
   connects to the hosts and the relay you configure.

## Commands, once the accounts exist

```sh
cd apps/mobile
npx eas build --profile preview --platform android    # an APK to install directly
npx eas build --profile production --platform all     # store builds
npx eas submit --profile production --platform ios    # to TestFlight
npx eas submit --profile production --platform android  # to the internal track, as a draft
```

## Before each release

- The App workflow is green on main: checks, Android emulator and iOS simulator.
- Raise `version` in `app.json` when the visible version should change.
- Read the iOS and Android device-flow screenshots from the latest run.

# Push notifications and TestFlight

Both are built and **off** until the owner's accounts exist. Nothing breaks without them.

## What's built

- **Library server** ([apps/library-server](../apps/library-server/README.md#push-to-phones)):
  - `POST /v1/devices` registers a phone's push token; `DELETE /v1/devices/<id>` removes it.
  - Each firing alert with a link is pushed to the registered phones.
  - Android through Firebase Cloud Messaging (HTTP v1), iPhone through APNs (`.p8` key).
  - Only `node:crypto` and `node:http2`: no Google or Apple library.
  - A push carries "ALERTNAME firing", the runbook path and the alert's `/open?…` link. No other
    labels, no annotations, no tokens.
  - Tokens the provider reports as gone are removed.
- **App** (Hosts & settings → **Alerts on this phone**):
  - Paste a devices token, turn on **Get alerts**: the phone registers its native push token.
  - A tap opens the alert's runbook through the normal link checks. Nothing runs by itself.
  - A build without Firebase or the APNs entitlement says **Not set up in this build**.
- **TestFlight** ([.github/workflows/app-testflight.yml](../.github/workflows/app-testflight.yml)):
  - On `v*` tags, and by hand on a tag. Skips with a notice while the secrets are missing.
  - Builds an unsigned archive without secrets. A second job signs it, a third uploads it.

## What the owner does

### Firebase (Android pushes, free)

1. [Firebase console](https://console.firebase.google.com/): add a project, then an Android app
   with package `dev.mdrunbook.app`.
2. Download **google-services.json** (the app's build needs it).
3. Project settings → Service accounts → **Generate new private key** (the server needs it).

### Apple (iPhone pushes and TestFlight)

1. Join the **Apple Developer Program**: 99 USD a year. Note the **Team ID** (Membership).
2. Identifiers → App ID `dev.mdrunbook.app`, with **Push Notifications** on.
3. Keys → a key with **APNs** → download `AuthKey_XXXXXXXXXX.p8` (only once). Note its Key ID.
4. Certificates → an **Apple Distribution** certificate. Export it from Keychain Access as `.p12`,
   with a password.
5. Profiles → an **App Store Connect** profile for `dev.mdrunbook.app` with that certificate.
6. [App Store Connect](https://appstoreconnect.apple.com/) → Apps → **New App** with that bundle
   ID. App Information shows its **Apple ID** (a number).
7. Users and Access → Integrations → App Store Connect API → a **team key**, role App Manager.
   Note the Issuer ID and Key ID; download the `.p8`.
8. TestFlight → a group of internal testers.

## Where each setting goes

### The library server (environment, Docker secrets)

| Variable | Value |
| --- | --- |
| `PUSH_FCM_SERVICE_ACCOUNT_FILE` | The Firebase service account key (JSON) |
| `PUSH_APNS_KEY_FILE` | `AuthKey_XXXXXXXXXX.p8` |
| `PUSH_APNS_KEY_ID`, `PUSH_APNS_TEAM_ID` | The key's ID, your Team ID |
| `PUSH_APNS_SANDBOX` | `true` only for builds from Xcode. TestFlight and App Store builds: leave it out |
| `DEVICES_TOKENS` | Tokens phones register with (`openssl rand -hex 32`), one per person. Default: the read tokens |

- Pushes need `ALERT_MAP` (alerts) too.
- The server then reaches `oauth2.googleapis.com`, `fcm.googleapis.com` and `api.push.apple.com`
  on 443.
- Caddy must send `/v1/devices` to the server
  ([Caddyfile.example](../apps/library-server/Caddyfile.example)).

### GitHub, environment `release` (Settings → Environments)

| Name | Kind | Value |
| --- | --- | --- |
| `ASC_KEY_ID` | secret | The App Store Connect API key's ID |
| `ASC_ISSUER_ID` | secret | Its Issuer ID |
| `ASC_KEY_P8` | secret | The API key `.p8`, base64 |
| `IOS_DIST_CERT_P12` | secret | The distribution `.p12`, base64 |
| `IOS_DIST_CERT_PASSWORD` | secret | Its password |
| `IOS_APPSTORE_PROFILE` | secret | The App Store profile (`.mobileprovision`), base64 |
| `ASC_APP_ID` | variable | The app's Apple ID (the number) |
| `IOS_PUSH` | variable, optional | `false` if the App ID has no Push Notifications |

- Base64 on one line: `base64 -i file` (macOS), `base64 -w0 file` (Linux),
  `[Convert]::ToBase64String([IO.File]::ReadAllBytes("file"))` (PowerShell).
- `release` takes only `v*` tags, so a manual run must be on a tag.

### The Android build

- Put `google-services.json` next to `apps/mobile/app.json`, or set `GOOGLE_SERVICES_JSON` to
  its path. It is git-ignored.
- The release APK workflow doesn't write it yet. Add one step before the build there:

  ```yaml
  - name: Firebase (pushes)
    env:
      GOOGLE_SERVICES: ${{ vars.GOOGLE_SERVICES_JSON }}
    if: env.GOOGLE_SERVICES != ''
    run: printf '%s' "$GOOGLE_SERVICES" > google-services.json
  ```

## How to test

- **Server:** `cd apps/library-server && npm test`. Fake FCM and APNs servers, no network.
- **Server, for real:** set the variables, then register a phone by hand:

  ```sh
  curl -sS -X POST -H "Authorization: Bearer $DEVICES_TOKEN" \
    -d '{"platform":"android","token":"<token>"}' https://runbooks.example.net/v1/devices
  ```

  Then post an alert to `/v1/alerts` (README, "Alerts"). The log says `push` with `sent`.
- **App, Android:** build with `google-services.json`, open Hosts & settings → Alerts on this
  phone, paste the devices token, turn it on.
- **App, iPhone:** a TestFlight build (production APNs). Or an Xcode build with
  `MD_RUNBOOK_IOS_PUSH=1` and `PUSH_APNS_SANDBOX=true` on the server.
- **TestFlight:** `gh workflow run app-testflight.yml --ref vX.Y.Z`. The build shows in TestFlight
  after Apple's processing.

## Why it is built this way

- **Native tokens, not Expo's push service:** alerts go from your server to Google or Apple
  directly. No third party in between.
- **Data-only FCM message:** expo-notifications shows `title` and `message` itself and hands
  `body` to the app. A `notification` block would bypass it.
- **One devices token per person:** only the token a phone registered with can change or remove
  it (`409` for another). Everyone who shares a token shares its phones.
- **Pruning:** only FCM `UNREGISTERED` and APNs 410. Not APNs `BadDeviceToken` or a bare 404,
  which a wrong setting causes for every phone.
- **Manual signing:** automatic signing needs the App Store Connect key on the build runner, and
  cloud signing needs an Admin key. Manual signing keeps the key in the upload job.
- **Signing in a job of its own:** the build runs npm, CocoaPods and Xcode script phases. So it
  archives with `CODE_SIGNING_ALLOWED=NO` and never sees the certificate.
- **The build's archive is checked, not trusted:**
  - The sign job unpacks it with Python's `tarfile` and `filter='data'`.
  - No paths or links out of the folder, no device files, no control characters in names.
  - One app, with a plain name (`[A-Za-z0-9._-]+.app`).
  - The app's path never goes to `GITHUB_ENV`. Each step finds the app again.
- **Entitlements:** an unsigned archive has none, and an export alone ships without the push
  entitlement. The sign job signs the archived app with them, then exports.
- **Which entitlements:** the app's file from `expo prebuild`, with values from the profile. A key
  the profile doesn't grant fails the job. The job checks the exported app for `aps-environment`.
- **The key:** imported into a temporary keychain, not extractable, for `codesign` only.
- **altool `--upload-package`:** Apple's documented replacement for the deprecated `--upload-app`.

## Open points

- The version stays `1.0.0` (`app.json`); each upload gets the run number as build number.
- App Store Connect asks about encryption per build until `ios.config.usesNonExemptEncryption`
  is set in `app.json`. The answer is the owner's.
- Store listing, screenshots and review are not automated.

## Sources

- FCM send: <https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages/send>
- FCM errors (`UNREGISTERED` 404): <https://firebase.google.com/docs/reference/fcm/rest/v1/ErrorCode>
- Google service account JWT (RS256, `jwt-bearer`, one hour):
  <https://developers.google.com/identity/protocols/oauth2/service-account>
- APNs token auth (ES256, `kid`, `iss`, 20–60 minutes):
  <https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns>
- APNs requests (HTTP/2, `/3/device/`, 4 KB):
  <https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns>
- APNs responses (410 Unregistered, BadDeviceToken 400):
  <https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns>
- expo-notifications (`getDevicePushTokenAsync`, `enableRemoteNotifications`, Android payload):
  <https://docs.expo.dev/versions/latest/sdk/notifications/>,
  <https://docs.expo.dev/push-notifications/sending-notifications-custom/>
- altool (`--upload-package`, `--apiKey`, `API_PRIVATE_KEYS_DIR`):
  <https://help.apple.com/asc/appsaltool/en.lproj/static.html>
- Unsigned archives lose entitlements: <https://developer.apple.com/forums/thread/772372>,
  <https://developer.apple.com/forums/thread/671800> (ITMS-90078 after `CODE_SIGNING_ALLOWED=NO`)
- Signing nested code inside out, no entitlements on frameworks:
  <https://developer.apple.com/documentation/xcode/using-the-latest-code-signature-format>
- `security import -x` and `-T`: <https://ss64.com/mac/security-export.html>
- Cloud signing with an API key needs Admin: <https://developer.apple.com/forums/thread/698117>

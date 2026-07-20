# InstaCheese 🧀

A family-only, Instagram-style mobile app for [HyperCheese](../README.md).
Browse the family photo feed, tell everyone about your favorites, bookmark
photos, comment, and upload straight from your phone's camera roll.

Built with [Expo](https://expo.dev) / React Native (TypeScript, expo-router).

## Features

- **Feed** — bullhorned favorites by default (switch to Everything for the
  full gallery), newest first, with infinite scroll and pull-to-refresh. Each
  card shows the first comment (with a "View all N comments" link when there
  are more), who the photo came from, and how long ago it was taken.
- **Bullhorn** 📢 — HyperCheese's social signal ("tells others about this
  item"); it shows up in the family activity feed. This is the "like" button.
- **Star** ⭐ — a private bookmark, like Instagram's save.
- **Comments** — view and post comments on any photo.
- **Upload** — pick photos/videos from your library and share them. Uploads
  use HyperCheese's dedupe-aware `/files` API, so re-uploading something the
  server already has is instant.
- **Videos** — play in the detail view via the server's streaming MP4.
- **Nightly mark reminder** — a local notification around 9 PM telling you
  how many camera-roll photos still need a Back up / Won't upload decision,
  so triage doesn't pile up. Nothing fires when you're caught up; tap it to
  jump straight to the Back up screen. Toggle on the Profile tab.
- Dark mode follows your system setting.

## Server requirements

The app works best against a HyperCheese server that includes the API token
support added alongside this app (JWT device tokens from `/files/auth` are
accepted as `Authorization: Bearer` on `/api` endpoints, and a `Source` is
auto-created for InstaCheese devices so uploads are imported and published
automatically).

**Compatibility mode:** against an older server, sign-in gracefully falls
back to a browser-style Devise session (cookie + CSRF token, exactly like
the web app). Browsing, bullhorns, stars, and comments all work; only
uploading is disabled, because an un-upgraded server would store the bytes
but never import them into the gallery. The profile and upload screens say
so when this mode is active — sign out and back in after upgrading the
server to switch to token mode.

## Development

```bash
cd instacheese
npm install
npx expo start
```

Then scan the QR code with the Expo Go app, or press `i` / `a` for a
simulator. Sign in with your HyperCheese server address, username, and
password.

## Android releases and installing with Obtainium

Every push to `master` that touches `instacheese/` runs the
`Build InstaCheese APK` workflow, which builds a release-signed APK and
publishes it as a GitHub release (tagged `v1.0.<build number>`). Install and
auto-update it on Android with [Obtainium](https://github.com/ImranR98/Obtainium):
add an app and give it this repository's URL — Obtainium grabs the APK from
the latest release and notifies you when a new one appears.

### One-time signing setup

Master builds are signed with a real release keystore and **fail if the
signing secrets are missing**. Generate a keystore and store it in the
repository's Actions secrets:

```bash
# 1. Generate a keystore (pick your own password; keep the file safe —
#    losing it means family phones must uninstall/reinstall to update)
keytool -genkeypair -v -keystore instacheese-release.keystore \
  -alias instacheese -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=InstaCheese"

# 2. Store the secrets (from the repo directory, using the gh CLI)
base64 -w0 instacheese-release.keystore | gh secret set ANDROID_KEYSTORE_BASE64
gh secret set ANDROID_KEYSTORE_PASSWORD   # paste the keystore password
gh secret set ANDROID_KEY_ALIAS --body "instacheese"
gh secret set ANDROID_KEY_PASSWORD        # paste the key password (same as
                                          # the keystore password unless you
                                          # chose a separate one)
```

Manual runs of the workflow on other branches (via workflow_dispatch) still
build an APK and upload it as a run artifact without creating a release;
without the secrets those builds fall back to debug signing, so an APK from
one can't update an installed release-signed app — uninstall first when
switching.

iOS remains manual for now: `npx eas build --platform ios` → TestFlight.

## Notes

- Sign-in uses your HyperCheese **username** (not email).
- Accounts without write permission get a read-only feed (no likes,
  comments, or uploads) until an admin bumps their role.
- iOS photos are requested in JPEG/H.264 ("compatible") form so the server's
  importer accepts them; HEIC-only originals are transcoded by iOS at pick
  time.

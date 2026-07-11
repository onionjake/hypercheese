# InstaCheese 🧀

A family-only, Instagram-style mobile app for [HyperCheese](../README.md).
Browse the family photo feed, tell everyone about your favorites, bookmark
photos, comment, and upload straight from your phone's camera roll.

Built with [Expo](https://expo.dev) / React Native (TypeScript, expo-router).

## Features

- **Feed** — the most recent published photos and videos, newest first, with
  infinite scroll and pull-to-refresh.
- **Bullhorn** 📢 — HyperCheese's social signal ("tells others about this
  item"); it shows up in the family activity feed. This is the "like" button.
- **Star** ⭐ — a private bookmark, like Instagram's save.
- **Comments** — view and post comments on any photo.
- **Upload** — pick photos/videos from your library and share them. Uploads
  use HyperCheese's dedupe-aware `/files` API, so re-uploading something the
  server already has is instant.
- **Videos** — play in the detail view via the server's streaming MP4.
- Dark mode follows your system setting.

## Server requirements

The app talks to a HyperCheese server that includes the API token support
added alongside this app (JWT device tokens from `/files/auth` are accepted
as `Authorization: Bearer` on `/api` endpoints, and a `Source` is
auto-created for InstaCheese devices so uploads are imported and published
automatically).

## Development

```bash
cd instacheese
npm install
npx expo start
```

Then scan the QR code with the Expo Go app, or press `i` / `a` for a
simulator. Sign in with your HyperCheese server address, username, and
password.

For a real install on family phones, build with EAS:

```bash
npx eas build --platform ios     # TestFlight
npx eas build --platform android # APK / Play Store
```

## Notes

- Sign-in uses your HyperCheese **username** (not email).
- Accounts without write permission get a read-only feed (no likes,
  comments, or uploads) until an admin bumps their role.
- iOS photos are requested in JPEG/H.264 ("compatible") form so the server's
  importer accepts them; HEIC-only originals are transcoded by iOS at pick
  time.

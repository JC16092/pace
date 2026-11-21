# pace

A personal work-hours and pay-tracking progressive web app (PWA), backed by Firebase.
Installable on mobile, works offline, and syncs live across devices.

- **Frontend:** vanilla JS PWA (service worker + web manifest)
- **Backend:** Firebase — Firestore + Google Authentication

## Setup (Firebase)

This app uses Firebase (Google Auth + Firestore). To run your own copy:

1. Create a free Firebase project.
2. In `public/firebase-config.js`, replace the `YOUR_*` placeholders with your
   web app config, and set `OWNER_EMAIL` to the Google account allowed to sign in.
3. Update the email in `firestore.rules` to match.
4. Deploy: `firebase deploy`.

## License

[MIT](LICENSE)

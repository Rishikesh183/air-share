# GestureDrop

Two phones, one 4-digit code. User A grabs a photo with a closed fist, User B catches it with an open palm. The photo travels directly between the two devices over WebRTC — Firebase only carries the handshake, never the file.

## Stack

- Next.js 15 (App Router) + TypeScript + Tailwind
- `@mediapipe/tasks-vision` GestureRecognizer (front camera, in-browser)
- WebRTC `RTCDataChannel` for the file itself
- Firebase Realtime Database — pairing and signaling only
- Firebase Anonymous Auth
- STUN: `stun:stun.l.google.com:19302` (no TURN in v1)

## Setup

```bash
npm install
cp .env.example .env.local   # then fill it in, see below
npm run dev
```

Open http://localhost:3000.

### Environment variables

Create `.env.local` (already scaffolded as a copy of `.env.example`) and fill in all five values. The app shows a configuration warning on the home screen until they are set.

```
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_DATABASE_URL=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=
```

Where each value comes from, in the [Firebase console](https://console.firebase.google.com):

| Variable | Where to find it |
| --- | --- |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Project settings → General → Your apps → Web app → `apiKey` |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | Same panel → `authDomain`, e.g. `my-project.firebaseapp.com` |
| `NEXT_PUBLIC_FIREBASE_DATABASE_URL` | Realtime Database → the URL at the top, e.g. `https://my-project-default-rtdb.firebaseio.com` |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | Same panel → `projectId` |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | Same panel → `appId`, e.g. `1:123456789:web:abc123` |

These are `NEXT_PUBLIC_*`, so they ship to the browser. That is expected for Firebase web config — access is controlled by `database.rules.json`, not by hiding these values. `.env.local` is gitignored; do not commit it.

### Firebase project setup

1. Create a project at https://console.firebase.google.com.
2. **Build → Authentication → Sign-in method → Anonymous → Enable.**
3. **Build → Realtime Database → Create database.** Pick a region, then start in *locked mode* — the rules below replace the defaults.
4. **Project settings → General → Your apps → Web (`</>`)** to register a web app and copy the config values into `.env.local`.
5. Publish the rules from `database.rules.json`: paste the file contents into **Realtime Database → Rules → Publish**, or deploy with the CLI:

   ```bash
   npm i -g firebase-tools
   firebase login
   firebase deploy --only database
   ```

   (For the CLI path, add a `firebase.json` with `{"database": {"rules": "database.rules.json"}}`.)

The rules require authentication, restrict writes to the room's `hostUid` / `guestUid`, and let `guestUid` be claimed only while it is unset.

## Testing on two phones

Both phones need HTTPS — the camera and `getUserMedia` are blocked on plain HTTP origins other than `localhost`.

**Easiest: deploy to Vercel.**

```bash
npm i -g vercel
vercel
```

Add the same five `NEXT_PUBLIC_FIREBASE_*` variables in the Vercel project settings, then open the deployment URL on both phones.

**Or tunnel your dev server:**

```bash
npm run dev
npx localtunnel --port 3000   # or: ngrok http 3000
```

Then, on both phones:

1. Phone A: **Create room** → a 4-digit code and QR appear.
2. Phone B: scan the QR, or tap **Join room** and type the code.
3. Both screens switch to **Connected to peer**.
4. Phone A: **Pick photo** → grant camera access → hold a **closed fist** for half a second.
5. Phone B: tap **Accept** on the first transfer, then hold an **open palm** for half a second.
6. Watch the progress bar, then tap **Save** on Phone B.

Either side can send; roles are not fixed.

### Testing on one laptop

Two browser tabs work, with one in a private/incognito window so the two get separate anonymous UIDs. Only one tab can hold the webcam at a time, so use the **Send without gesture** / **Receive without gesture** fallback buttons in the other. To exercise the gesture hook itself, use the tab that owns the camera.

## How it works

- **Pairing** — `rooms/{code}` in RTDB holds `{createdAt, updatedAt, hostUid, guestUid, offer, answer, hostCandidates/, guestCandidates/}`. Codes are random 4 digits with retry on collision; a third joiner is rejected with "Room full". The host registers `onDisconnect().remove()` so the room disappears when they leave, and rooms idle for more than 10 minutes are treated as expired and reusable.
- **Signaling** — the host creates the data channel and the offer once a guest appears; the guest answers. ICE candidates go to their own lists. Once the channel opens, nothing else goes through Firebase.
- **Gestures** — `lib/gestures.ts` exposes `useGesture(target, onDetected)`: `runningMode: "VIDEO"`, one hand, confidence ≥ 0.7, a continuous 500 ms hold before firing, then a 1.5 s cooldown. The camera starts only when a gesture is expected and every track is stopped otherwise. The tab going hidden pauses it; returning resumes it.
- **Transfer** — `META → READY → binary chunks → DONE → ACK`, 16 KB chunks, paused above 1 MB of `bufferedAmount` and resumed on `bufferedamountlow`. Limit 25 MB.
- **Privacy** — every photo is redrawn through a canvas and re-encoded as JPEG (quality 0.92) before sending, which drops EXIF including GPS. A file the browser cannot decode (HEIC on most desktop browsers) surfaces "Unsupported format" rather than crashing.

### Edge cases handled

- Peer drops mid-grab or mid-transfer → both sides reset, the sender keeps the photo.
- A grab nobody catches within 60 s auto-cancels on both sides.
- Grabbing again while one is pending replaces it and tells the receiver.
- No WebRTC connection within 15 s → "Couldn't connect directly. Try same Wi-Fi or mobile hotspot."
- Camera denied or missing → fallback buttons, with the error shown inline.
- Tab hidden pauses the camera; Wake Lock keeps the screen on in a room where supported.
- The receiver sees an accept prompt the first time a peer sends.

## Project layout

```
app/page.tsx                    Create / Join
app/room/[code]/page.tsx        Route shell
app/room/[code]/RoomClient.tsx  Main room screen
components/CameraGesture.tsx
components/PhotoPicker.tsx
components/TransferProgress.tsx
lib/firebase.ts                 App init + anonymous auth
lib/signaling.ts                Room create/join/leave, offer/answer/candidates
lib/webrtc.ts                   Peer connection + data channel
lib/transfer.ts                 Chunking, backpressure, EXIF strip, save
lib/gestures.ts                 useGesture, useWakeLock
database.rules.json
```

## Out of scope in v1

Nearby discovery, TURN, videos, multi-file, more than two devices, server-side storage.

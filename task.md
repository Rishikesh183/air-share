# Task: GestureDrop — gesture-based photo transfer between two phones (web app)

## Goal
Build a mobile-first web app where two users pair their phones, User A "grabs" a photo with a hand gesture, and User B "releases" it with a gesture to receive it. Transfer is peer-to-peer (WebRTC). No native app, no install.

## Stack (use exactly this)
- Next.js 15 (App Router) + TypeScript + Tailwind
- `@mediapipe/tasks-vision` — GestureRecognizer (runs in browser, front camera)
- WebRTC `RTCDataChannel` for file transfer
- Firebase Realtime Database for pairing + WebRTC signaling ONLY (no file storage)
- Firebase Anonymous Auth
- Deploy target: Vercel
- STUN: `stun:stun.l.google.com:19302` (no TURN in v1)

## Environment variables (read from `.env.local`, never hardcode)
```
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_DATABASE_URL=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=
```
Create `.env.example` with these keys (empty values).

## User flow
1. Open site → signed in anonymously automatically.
2. **Create room** → shows 4-digit code + QR code. OR **Join room** → enter code / scan QR.
3. When both join → WebRTC connection established → both screens show "Connected to peer".
4. **Sender (A):** taps "Pick photo" (file input, `accept="image/*"`) → preview shown → camera turns on → user makes **Closed_Fist** held for 500 ms → photo is "grabbed" (animation: photo shrinks into hand), metadata sent to B: `{name, size, type}`.
5. **Receiver (B):** screen shows "Photo incoming — open your palm" → camera on → **Open_Palm** held for 500 ms → B sends `READY` → A streams file over data channel.
6. B shows progress bar → on completion shows image + "Save" button (use Web Share API with file if supported, else `<a download>`).
7. Either user can send next photo; roles are not fixed (both can send).

## Implementation requirements

### Pairing / signaling (Firebase RTDB)
- Path: `rooms/{code}` with `{createdAt, hostUid, guestUid, offer, answer, hostCandidates/, guestCandidates/}`.
- Code: random 4 digits, retry if exists.
- Max 2 users per room; third joiner gets "Room full".
- Room expires after 10 minutes of inactivity; delete room node on disconnect using `onDisconnect().remove()` for host.
- Once data channel is open, all further messages go over the data channel, not Firebase.

### Firebase security rules (write to `database.rules.json`)
- Only authenticated users can read/write.
- Only `hostUid` / `guestUid` can write to their room.
- `guestUid` can only be set once (when null).

### Gesture detection
- Module: `lib/gestures.ts` exporting a hook `useGesture(targetGesture, onDetected)`.
- Use GestureRecognizer with `runningMode: "VIDEO"`, 1 hand, confidence ≥ 0.7.
- Trigger only if the gesture stays continuous for 500 ms (debounce against false triggers).
- 1.5 s cooldown after a trigger.
- Camera starts only when a gesture is expected; stop all tracks when not needed (battery).
- Show small camera preview in corner + label of currently detected gesture.
- Fallback button ("Send without gesture" / "Receive without gesture") for low-light / no camera permission.

### File transfer (`lib/transfer.ts`)
- Chunk size 16 KB; respect `bufferedAmount` backpressure (pause above 1 MB, resume on `bufferedamountlow`).
- Protocol messages (JSON over same channel, binary for chunks):
  `META {id,name,size,type}` → `READY {id}` → binary chunks → `DONE {id}` → `ACK {id}`.
- Max file size 25 MB in v1; reject larger with message.
- Before sending: strip EXIF (redraw image to canvas and export as JPEG quality 0.92). Convert HEIC if browser can't decode → show error "Unsupported format" instead of crashing.

### Edge cases (must handle)
- Peer disconnects mid-grab or mid-transfer → cancel, show message, sender keeps photo.
- Grabbed photo not released within 60 s → auto-cancel.
- Sender grabs again while one is pending → replace pending one (tell receiver).
- WebRTC fails to connect within 15 s → show "Couldn't connect directly. Try same Wi-Fi or mobile hotspot."
- Camera permission denied → show fallback buttons.
- Page hidden (`visibilitychange`) → pause camera; on return, resume.
- Screen wake: use Wake Lock API while in a room (if supported).
- Receiver must see an accept prompt the first time a peer sends (prevent unwanted files).

## Pages / structure
```
app/page.tsx            -> Create / Join
app/room/[code]/page.tsx -> main room screen
components/CameraGesture.tsx
components/PhotoPicker.tsx
components/TransferProgress.tsx
lib/firebase.ts
lib/signaling.ts
lib/webrtc.ts
lib/transfer.ts
lib/gestures.ts
database.rules.json
.env.example
README.md
```

## UI
- Mobile-first, portrait, large touch targets, dark theme.
- Clear state text at all times: "Waiting for peer", "Connected", "Make a fist to grab", "Open palm to receive", "Receiving 45%".

## Out of scope (v1)
- Automatic nearby discovery, TURN server, videos, multi-file, more than 2 devices, server-side file storage.

## Deliverables
1. Working app runnable with `npm run dev`.
2. `README.md`: setup steps, Firebase setup, how to test on two phones.
3. `database.rules.json`.
4. No secrets committed.

## Acceptance test (do this before saying done)
- `npm run build` passes with no type errors.
- Two browser tabs (one incognito) can pair via code and transfer a photo using fallback buttons.
- Gesture hook detects Closed_Fist and Open_Palm on a laptop webcam.
- Disconnecting one tab mid-transfer shows an error on the other without crashing.
"use client";

import {
  DataSnapshot,
  get,
  onChildAdded,
  onDisconnect,
  onValue,
  push,
  ref,
  remove,
  runTransaction,
  serverTimestamp,
  set,
  update,
} from "firebase/database";
import { ensureSignedIn, getDb } from "./firebase";

export type Role = "host" | "guest";

export const ROOM_TTL_MS = 10 * 60 * 1000; // 10 minutes of inactivity

export interface RoomData {
  createdAt?: number;
  updatedAt?: number;
  hostUid?: string | null;
  guestUid?: string | null;
  offer?: RTCSessionDescriptionInit | null;
  answer?: RTCSessionDescriptionInit | null;
}

export class RoomFullError extends Error {
  constructor() {
    super("Room full");
    this.name = "RoomFullError";
  }
}

export class RoomMissingError extends Error {
  constructor() {
    super("Room not found. Check the code and try again.");
    this.name = "RoomMissingError";
  }
}

export class RoomExpiredError extends Error {
  constructor() {
    super("That room expired. Ask for a new code.");
    this.name = "RoomExpiredError";
  }
}

function roomRef(code: string) {
  return ref(getDb(), `rooms/${code}`);
}

function randomCode(): string {
  return String(Math.floor(Math.random() * 10000)).padStart(4, "0");
}

function isExpired(room: RoomData | null): boolean {
  if (!room) return true;
  const stamp = room.updatedAt ?? room.createdAt ?? 0;
  return typeof stamp === "number" && stamp > 0 && Date.now() - stamp > ROOM_TTL_MS;
}

/** Creates a room with an unused 4-digit code and returns it. */
export async function createRoom(): Promise<{ code: string; uid: string }> {
  const uid = await ensureSignedIn();

  for (let attempt = 0; attempt < 25; attempt++) {
    const code = randomCode();
    const node = roomRef(code);

    const result = await runTransaction(node, (current: RoomData | null) => {
      if (current && !isExpired(current)) return undefined; // taken, abort
      return {
        createdAt: Date.now(),
        updatedAt: Date.now(),
        hostUid: uid,
        guestUid: null,
        offer: null,
        answer: null,
      } satisfies RoomData;
    });

    if (result.committed) {
      // Host owns the room: clean it up if the host drops off.
      onDisconnect(node).remove();
      await update(node, { createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      return { code, uid };
    }
  }

  throw new Error("Couldn't allocate a room code. Try again.");
}

/** Claims the guest slot of an existing room. */
export async function joinRoom(code: string): Promise<{ uid: string }> {
  const uid = await ensureSignedIn();
  const node = roomRef(code);

  const snapshot = await get(node);
  if (!snapshot.exists()) throw new RoomMissingError();
  if (isExpired(snapshot.val() as RoomData)) throw new RoomExpiredError();

  const result = await runTransaction(node, (current: RoomData | null) => {
    if (!current) return null; // gone in the meantime
    if (current.hostUid === uid) return current; // host reloading its own page
    if (current.guestUid && current.guestUid !== uid) return undefined; // full, abort
    return { ...current, guestUid: uid, updatedAt: Date.now() };
  });

  if (!result.committed) throw new RoomFullError();
  if (!result.snapshot.exists()) throw new RoomMissingError();

  const room = result.snapshot.val() as RoomData;
  if (room.hostUid !== uid) {
    onDisconnect(ref(getDb(), `rooms/${code}/guestUid`)).remove();
  }

  return { uid };
}

/** Resolves the caller's role in a room, or null if they are not a member. */
export async function getRole(code: string, uid: string): Promise<Role | null> {
  const snapshot = await get(roomRef(code));
  if (!snapshot.exists()) return null;
  const room = snapshot.val() as RoomData;
  if (room.hostUid === uid) return "host";
  if (room.guestUid === uid) return "guest";
  return null;
}

export function touchRoom(code: string): void {
  void update(roomRef(code), { updatedAt: serverTimestamp() });
}

export async function setOffer(code: string, offer: RTCSessionDescriptionInit) {
  await update(roomRef(code), { offer, updatedAt: serverTimestamp() });
}

export async function setAnswer(code: string, answer: RTCSessionDescriptionInit) {
  await update(roomRef(code), { answer, updatedAt: serverTimestamp() });
}

export async function addCandidate(code: string, role: Role, candidate: RTCIceCandidateInit) {
  const listRef = ref(getDb(), `rooms/${code}/${role}Candidates`);
  await set(push(listRef), { ...candidate });
}

export function watchRoom(code: string, cb: (room: RoomData | null) => void): () => void {
  return onValue(roomRef(code), (snap: DataSnapshot) => cb(snap.val() as RoomData | null));
}

export function watchCandidates(
  code: string,
  role: Role,
  cb: (candidate: RTCIceCandidateInit) => void
): () => void {
  const listRef = ref(getDb(), `rooms/${code}/${role}Candidates`);
  return onChildAdded(listRef, (snap) => cb(snap.val() as RTCIceCandidateInit));
}

/** Host tears the room down; guest only releases its own slot. */
export async function leaveRoom(code: string, role: Role): Promise<void> {
  const node = roomRef(code);
  try {
    if (role === "host") {
      await onDisconnect(node).cancel();
      await remove(node);
    } else {
      const slot = ref(getDb(), `rooms/${code}/guestUid`);
      await onDisconnect(slot).cancel();
      await remove(slot);
    }
  } catch {
    // Leaving is best-effort; the TTL sweep and onDisconnect cover failures.
  }
}

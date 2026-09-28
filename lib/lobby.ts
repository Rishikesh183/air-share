"use client";

import {
  DatabaseReference,
  onDisconnect,
  onValue,
  ref,
  remove,
  serverTimestamp,
  set,
  update,
} from "firebase/database";
import { getDb } from "./firebase";

export const INVITE_TTL_MS = 30_000;
const MAX_LISTED_PEERS = 20;

export interface LobbyPeer {
  uid: string;
  name: string;
  joinedAt: number;
}

export type InviteStatus = "pending" | "accepted" | "declined";

export interface Invite {
  fromUid: string;
  fromName: string;
  code: string;
  lobby: string;
  createdAt: number;
  status: InviteStatus;
}

/** Asks the server which network lobby this device belongs to. */
export async function fetchLobbyId(): Promise<string> {
  const res = await fetch("/api/lobby", { cache: "no-store" });
  if (!res.ok) throw new Error("Nearby devices are unavailable right now.");
  const body = (await res.json()) as { lobby?: string };
  if (!body.lobby) throw new Error("Nearby devices are unavailable right now.");
  return body.lobby;
}

/* ---------- presence ---------- */

// Presence is ref-counted per path so overlapping mounts (React strict mode,
// fast navigation) never remove a node another mount still relies on.
const presenceCounts = new Map<string, number>();
let presenceQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = presenceQueue.then(task, task);
  presenceQueue = next.catch(() => undefined);
  return next;
}

function presenceRef(lobby: string, uid: string): DatabaseReference {
  return ref(getDb(), `lobby/${lobby}/${uid}`);
}

/** Announces this device in the lobby. Resolves with a function that leaves it. */
export async function joinLobby(
  lobby: string,
  uid: string,
  name: string
): Promise<() => Promise<void>> {
  const path = `${lobby}/${uid}`;
  const node = presenceRef(lobby, uid);

  await enqueue(async () => {
    presenceCounts.set(path, (presenceCounts.get(path) ?? 0) + 1);
    await onDisconnect(node).remove();
    await set(node, { name, joinedAt: serverTimestamp() });
  });

  let left = false;
  return () =>
    enqueue(async () => {
      if (left) return;
      left = true;
      const remaining = (presenceCounts.get(path) ?? 1) - 1;
      if (remaining > 0) {
        presenceCounts.set(path, remaining);
        return;
      }
      presenceCounts.delete(path);
      try {
        await onDisconnect(node).cancel();
        await remove(node);
      } catch {
        // Best effort: onDisconnect still cleans up if this fails.
      }
    });
}

export async function renameInLobby(lobby: string, uid: string, name: string): Promise<void> {
  await update(presenceRef(lobby, uid), { name });
}

export function watchLobby(
  lobby: string,
  selfUid: string,
  onPeers: (peers: LobbyPeer[]) => void,
  onError: (err: Error) => void
): () => void {
  return onValue(
    ref(getDb(), `lobby/${lobby}`),
    (snap) => {
      const raw = (snap.val() ?? {}) as Record<string, { name?: unknown; joinedAt?: unknown }>;
      const peers = Object.entries(raw)
        .filter(([uid]) => uid !== selfUid)
        .map(([uid, entry]) => ({
          uid,
          name: typeof entry?.name === "string" ? entry.name : "Unknown device",
          joinedAt: typeof entry?.joinedAt === "number" ? entry.joinedAt : 0,
        }))
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .slice(0, MAX_LISTED_PEERS);
      onPeers(peers);
    },
    onError
  );
}

/* ---------- invites ---------- */

function inviteRef(toUid: string, fromUid: string): DatabaseReference {
  return ref(getDb(), `invites/${toUid}/${fromUid}`);
}

export async function sendInvite(
  toUid: string,
  invite: Pick<Invite, "fromUid" | "fromName" | "code" | "lobby">
): Promise<void> {
  const node = inviteRef(toUid, invite.fromUid);
  await onDisconnect(node).remove();
  await set(node, { ...invite, createdAt: serverTimestamp(), status: "pending" });
}

export async function cancelInvite(toUid: string, fromUid: string): Promise<void> {
  const node = inviteRef(toUid, fromUid);
  try {
    await onDisconnect(node).cancel();
    await remove(node);
  } catch {
    // Already gone.
  }
}

/** The inviter watches its own invite for the answer. */
export function watchSentInvite(
  toUid: string,
  fromUid: string,
  cb: (invite: Invite | null) => void
): () => void {
  return onValue(
    inviteRef(toUid, fromUid),
    (snap) => cb(snap.val() as Invite | null),
    () => cb(null)
  );
}

export function watchIncomingInvites(uid: string, cb: (invites: Invite[]) => void): () => void {
  return onValue(
    ref(getDb(), `invites/${uid}`),
    (snap) => {
      const raw = (snap.val() ?? {}) as Record<string, Invite>;
      cb(Object.values(raw).sort((a, b) => a.createdAt - b.createdAt));
    },
    () => cb([])
  );
}

export async function respondToInvite(
  myUid: string,
  fromUid: string,
  status: Exclude<InviteStatus, "pending">
): Promise<void> {
  await set(ref(getDb(), `invites/${myUid}/${fromUid}/status`), status);
}

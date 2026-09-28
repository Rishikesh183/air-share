"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_NAME_LENGTH, getDeviceName, saveDeviceName } from "@/lib/deviceName";
import { ensureSignedIn } from "@/lib/firebase";
import {
  INVITE_TTL_MS,
  Invite,
  LobbyPeer,
  cancelInvite,
  fetchLobbyId,
  joinLobby,
  renameInLobby,
  respondToInvite,
  sendInvite,
  watchIncomingInvites,
  watchLobby,
  watchSentInvite,
} from "@/lib/lobby";
import { RoomFullError, createRoom, joinRoom, leaveRoom } from "@/lib/signaling";

interface Outgoing {
  toUid: string;
  toName: string;
  code: string | null;
}

// Allows for clock skew between devices when judging whether an invite is stale.
const STALE_SLACK_MS = 15_000;

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((word) => word[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

/** Lists devices on the same network and handles invites in both directions. */
export default function NearbyDevices() {
  const router = useRouter();
  const [uid, setUid] = useState<string | null>(null);
  const [lobby, setLobby] = useState<string | null>(null);
  const [lobbyError, setLobbyError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [peers, setPeers] = useState<LobbyPeer[]>([]);
  const [outgoing, setOutgoing] = useState<Outgoing | null>(null);
  const [incoming, setIncoming] = useState<Invite | null>(null);
  const [answering, setAnswering] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Ends the current outgoing invite; null when there is none.
  const endOutgoingRef = useRef<((message?: string) => void) | null>(null);

  /* ---------- join the network lobby ---------- */

  useEffect(() => {
    let cancelled = false;
    let leave: (() => Promise<void>) | null = null;
    const deviceName = getDeviceName();
    setName(deviceName);

    void (async () => {
      try {
        const [me, lobbyId] = await Promise.all([ensureSignedIn(), fetchLobbyId()]);
        if (cancelled) return;
        const leaveFn = await joinLobby(lobbyId, me, deviceName);
        if (cancelled) {
          void leaveFn();
          return;
        }
        leave = leaveFn;
        setUid(me);
        setLobby(lobbyId);
      } catch (err) {
        if (!cancelled) {
          setLobbyError(err instanceof Error ? err.message : "Nearby devices are unavailable.");
        }
      }
    })();

    return () => {
      cancelled = true;
      void leave?.();
    };
  }, []);

  useEffect(() => {
    if (!lobby || !uid) return;
    return watchLobby(lobby, uid, setPeers, () =>
      setLobbyError("Nearby devices are unavailable right now.")
    );
  }, [lobby, uid]);

  useEffect(() => {
    if (!uid) return;
    return watchIncomingInvites(uid, (invites) => {
      const fresh = invites.find(
        (invite) =>
          invite.status === "pending" &&
          Date.now() - invite.createdAt < INVITE_TTL_MS + STALE_SLACK_MS
      );
      setIncoming(fresh ?? null);
      if (!fresh) setAnswering(false);
    });
  }, [uid]);

  // Leaving the page with an unanswered invite withdraws it and closes its room.
  useEffect(() => () => endOutgoingRef.current?.(), []);

  /* ---------- sending an invite ---------- */

  const invitePeer = useCallback(
    async (peer: LobbyPeer) => {
      if (!uid || !lobby || endOutgoingRef.current) return;

      setNotice(null);
      setOutgoing({ toUid: peer.uid, toName: peer.name, code: null });

      let code: string | null = null;
      let unsubscribe: (() => void) | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let finished = false;

      const finish = (message?: string, keepRoom = false) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        unsubscribe?.();
        endOutgoingRef.current = null;
        void cancelInvite(peer.uid, uid);
        if (keepRoom) return;
        if (code) void leaveRoom(code, "host");
        setOutgoing(null);
        if (message) setNotice(message);
      };
      endOutgoingRef.current = finish;

      try {
        code = (await createRoom()).code;
        if (finished) {
          void leaveRoom(code, "host");
          return;
        }

        await sendInvite(peer.uid, { fromUid: uid, fromName: name, code, lobby });
        if (finished) {
          // Cancelled while the write was in flight; make sure it is gone.
          void cancelInvite(peer.uid, uid);
          return;
        }

        const roomCode = code;
        setOutgoing({ toUid: peer.uid, toName: peer.name, code: roomCode });
        timer = setTimeout(() => finish(`${peer.name} didn't answer.`), INVITE_TTL_MS);

        unsubscribe = watchSentInvite(peer.uid, uid, (invite) => {
          if (finished) return;
          if (!invite) {
            finish(`${peer.name} is no longer available.`);
          } else if (invite.status === "accepted") {
            finish(undefined, true);
            router.push(`/room/${roomCode}`);
          } else if (invite.status === "declined") {
            finish(`${peer.name} declined.`);
          }
        });
        // The listener can fire synchronously from cache and finish before we held it.
        if (finished) unsubscribe();
      } catch (err) {
        const denied = err instanceof Error && /permission/i.test(err.message);
        finish(denied ? `${peer.name} is no longer available.` : "Could not send the invite.");
      }
    },
    [uid, lobby, name, router]
  );

  /* ---------- answering an invite ---------- */

  const acceptInvite = useCallback(async () => {
    if (!incoming || !uid) return;
    const invite = incoming;
    setAnswering(true);
    try {
      await joinRoom(invite.code);
      await respondToInvite(uid, invite.fromUid, "accepted");
      router.push(`/room/${invite.code}`);
    } catch (err) {
      void respondToInvite(uid, invite.fromUid, "declined").catch(() => undefined);
      setNotice(
        err instanceof RoomFullError
          ? "That room is already full."
          : "That invite is no longer available."
      );
      setAnswering(false);
    }
  }, [incoming, uid, router]);

  const declineInvite = useCallback(async () => {
    if (!incoming || !uid) return;
    const invite = incoming;
    setIncoming(null);
    try {
      await respondToInvite(uid, invite.fromUid, "declined");
    } catch {
      // The inviter already withdrew it.
    }
  }, [incoming, uid]);

  /* ---------- renaming ---------- */

  function commitName(event: React.FormEvent) {
    event.preventDefault();
    const next = saveDeviceName(draft);
    setName(next);
    setEditing(false);
    if (lobby && uid) void renameInLobby(lobby, uid, next).catch(() => undefined);
  }

  /* ---------- render ---------- */

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-zinc-400">Nearby</h2>
        {!editing && name && (
          <button
            type="button"
            onClick={() => {
              setDraft(name);
              setEditing(true);
            }}
            className="truncate text-xs text-zinc-500 hover:text-zinc-300"
          >
            You appear as <span className="text-zinc-300">{name}</span> · Edit
          </button>
        )}
      </div>

      {editing && (
        <form onSubmit={commitName} className="flex gap-2">
          <input
            autoFocus
            value={draft}
            maxLength={MAX_NAME_LENGTH}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="Your device name"
            className="min-w-0 flex-1 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-3 text-base text-zinc-100 outline-none focus:border-emerald-600"
          />
          <button
            type="submit"
            className="rounded-xl bg-emerald-600 px-4 py-3 text-sm font-medium text-white hover:bg-emerald-500"
          >
            Save
          </button>
        </form>
      )}

      {lobbyError ? (
        <p className="text-sm text-zinc-500">{lobbyError}</p>
      ) : !lobby ? (
        <p className="text-sm text-zinc-500">Looking for devices on your network…</p>
      ) : peers.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-800 p-4 text-center text-sm text-zinc-500">
          No one nearby yet. Open GestureDrop on another device on the same Wi-Fi.
        </div>
      ) : (
        <ul className="space-y-2">
          {peers.map((peer) => {
            const pending = outgoing?.toUid === peer.uid;
            return (
              <li key={peer.uid}>
                <button
                  type="button"
                  disabled={Boolean(outgoing) && !pending}
                  onClick={() => void invitePeer(peer)}
                  className="flex w-full items-center justify-between gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 px-4 py-4 text-left transition hover:border-zinc-700 disabled:opacity-40"
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-emerald-900/60 text-sm font-semibold text-emerald-300">
                      {initials(peer.name)}
                    </span>
                    <span className="truncate text-base font-medium text-zinc-100">{peer.name}</span>
                  </span>
                  <span className="shrink-0 text-sm font-medium text-emerald-400">
                    {pending ? (outgoing?.code ? "Waiting…" : "Inviting…") : "Connect"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {outgoing && (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/60 px-4 py-3">
          <p className="text-sm text-zinc-300">Waiting for {outgoing.toName} to allow…</p>
          <button
            type="button"
            onClick={() => endOutgoingRef.current?.("Invite cancelled.")}
            className="shrink-0 rounded-lg bg-zinc-800 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-700"
          >
            Cancel
          </button>
        </div>
      )}

      {notice && (
        <p role="status" className="text-center text-sm text-zinc-400">
          {notice}
        </p>
      )}

      {incoming && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="invite-title"
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center"
        >
          <div className="w-full max-w-md rounded-3xl border border-zinc-800 bg-zinc-900 p-6 shadow-2xl">
            <div className="flex items-center gap-3">
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-emerald-900/60 text-base font-semibold text-emerald-300">
                {initials(incoming.fromName)}
              </span>
              <p id="invite-title" className="text-lg font-semibold text-zinc-100">
                {incoming.fromName} wants to connect
              </p>
            </div>
            <p className="mt-3 text-sm text-zinc-400">
              You&apos;ll join a room together. You still approve each photo before it arrives.
            </p>
            <div className="mt-6 flex gap-3">
              <button
                type="button"
                onClick={() => void declineInvite()}
                disabled={answering}
                className="flex-1 rounded-xl bg-zinc-800 px-4 py-4 text-base font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
              >
                Decline
              </button>
              <button
                type="button"
                onClick={() => void acceptInvite()}
                disabled={answering}
                className="flex-1 rounded-xl bg-emerald-600 px-4 py-4 text-base font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
              >
                {answering ? "Connecting…" : "Allow"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

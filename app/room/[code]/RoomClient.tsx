"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import CameraGesture from "@/components/CameraGesture";
import PhotoPicker from "@/components/PhotoPicker";
import TransferProgress from "@/components/TransferProgress";
import { ensureSignedIn, isFirebaseConfigured } from "@/lib/firebase";
import { useWakeLock } from "@/lib/gestures";
import { Role, getRole, joinRoom, leaveRoom, touchRoom } from "@/lib/signaling";
import {
  ControlMessage,
  FileMeta,
  FileReceiver,
  MAX_FILE_BYTES,
  RELEASE_TIMEOUT_MS,
  formatBytes,
  newTransferId,
  parseControl,
  saveFile,
  sendControl,
  sendFile,
} from "@/lib/transfer";
import { PeerStatus, startPeer } from "@/lib/webrtc";

type SendPhase = "idle" | "grabbing" | "pending" | "sending" | "done";
type RecvPhase = "idle" | "prompting" | "waiting-release" | "receiving" | "done";

interface IncomingDone {
  meta: FileMeta;
  url: string;
  blob: Blob;
}

export default function RoomClient({ code }: { code: string }) {
  const router = useRouter();

  const [role, setRole] = useState<Role | null>(null);
  const [status, setStatus] = useState<PeerStatus>("connecting");
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [joinUrl, setJoinUrl] = useState("");

  // Sending state
  const [sendPhase, setSendPhase] = useState<SendPhase>("idle");
  const [sentBytes, setSentBytes] = useState(0);
  const [grabAnimating, setGrabAnimating] = useState(false);
  const fileRef = useRef<File | null>(null);
  const sendIdRef = useRef<string | null>(null);
  const cancelRef = useRef<{ cancelled: boolean }>({ cancelled: false });
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);

  // Receiving state
  const [recvPhase, setRecvPhase] = useState<RecvPhase>("idle");
  const [incomingMeta, setIncomingMeta] = useState<FileMeta | null>(null);
  const [recvBytes, setRecvBytes] = useState(0);
  const [incoming, setIncoming] = useState<IncomingDone | null>(null);
  const receiverRef = useRef<FileReceiver | null>(null);
  const acceptedPeerRef = useRef(false); // accept prompt only on the first send

  const channelRef = useRef<RTCDataChannel | null>(null);
  const [channelOpen, setChannelOpen] = useState(false);

  useWakeLock(status === "connected");

  const clearReleaseTimer = useCallback(() => {
    if (releaseTimerRef.current) {
      clearTimeout(releaseTimerRef.current);
      releaseTimerRef.current = null;
    }
  }, []);

  const resetSend = useCallback(
    (message?: string) => {
      clearReleaseTimer();
      cancelRef.current.cancelled = true;
      cancelRef.current = { cancelled: false };
      sendIdRef.current = null;
      setSendPhase("idle");
      setSentBytes(0);
      setGrabAnimating(false);
      if (message) setNotice(message);
    },
    [clearReleaseTimer]
  );

  const resetReceive = useCallback((message?: string) => {
    receiverRef.current = null;
    setRecvPhase("idle");
    setIncomingMeta(null);
    setRecvBytes(0);
    if (message) setNotice(message);
  }, []);

  /* ---------- membership ---------- */

  useEffect(() => {
    if (!isFirebaseConfigured()) {
      setStatus("failed");
      setStatusDetail("Firebase is not configured. See README.md.");
      return;
    }
    if (!/^\d{4}$/.test(code)) {
      setStatus("failed");
      setStatusDetail("That room code is not valid.");
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const uid = await ensureSignedIn();
        let resolved = await getRole(code, uid);
        if (!resolved) {
          // Arrived by QR or direct link without going through the home screen.
          await joinRoom(code);
          resolved = await getRole(code, uid);
        }
        if (cancelled) return;
        if (!resolved) {
          setStatus("failed");
          setStatusDetail("You are not a member of this room.");
          return;
        }
        setRole(resolved);
      } catch (err) {
        if (cancelled) return;
        setStatus("failed");
        setStatusDetail(err instanceof Error ? err.message : "Could not join this room.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code]);

  /* ---------- share link + QR ---------- */

  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = `${window.location.origin}/room/${code}`;
    setJoinUrl(url);
    QRCode.toDataURL(url, { width: 320, margin: 1, color: { dark: "#fafafa", light: "#09090b" } })
      .then(setQr)
      .catch(() => setQr(null));
  }, [code]);

  /* ---------- keep the room alive while it is in use ---------- */

  useEffect(() => {
    if (!role) return;
    touchRoom(code);
    const timer = setInterval(() => touchRoom(code), 60_000);
    return () => clearInterval(timer);
  }, [code, role]);

  /* ---------- incoming data-channel messages ---------- */

  const handleControl = useCallback(
    (message: ControlMessage) => {
      const channel = channelRef.current;

      switch (message.kind) {
        case "META": {
          const meta: FileMeta = {
            id: message.id,
            name: message.name,
            size: message.size,
            type: message.type,
          };
          if (meta.size > MAX_FILE_BYTES) {
            if (channel)
              sendControl(channel, { kind: "REJECT", id: meta.id, reason: "File too large" });
            return;
          }
          // A second grab replaces whatever was pending.
          receiverRef.current = null;
          setRecvBytes(0);
          setIncomingMeta(meta);
          setRecvPhase(acceptedPeerRef.current ? "waiting-release" : "prompting");
          setNotice(null);
          break;
        }

        case "READY": {
          if (sendIdRef.current !== message.id) return;
          clearReleaseTimer();
          setSendPhase("sending");
          void streamPendingFile();
          break;
        }

        case "ACK": {
          if (sendIdRef.current !== message.id) return;
          clearReleaseTimer();
          sendIdRef.current = null;
          fileRef.current = null;
          setSelectedName(null);
          setSendPhase("done");
          setNotice("Photo delivered.");
          break;
        }

        case "DONE": {
          const receiver = receiverRef.current;
          if (!receiver || receiver.meta.id !== message.id) return;
          const blob = receiver.toBlob();
          receiverRef.current = null;
          setIncoming({ meta: receiver.meta, blob, url: URL.createObjectURL(blob) });
          setRecvPhase("done");
          setIncomingMeta(null);
          if (channel) sendControl(channel, { kind: "ACK", id: message.id });
          break;
        }

        case "CANCEL": {
          if (receiverRef.current?.meta.id === message.id || incomingMeta?.id === message.id) {
            resetReceive(message.reason || "The sender cancelled.");
          }
          if (sendIdRef.current === message.id) {
            resetSend(message.reason || "The receiver cancelled.");
          }
          break;
        }

        case "REJECT": {
          if (sendIdRef.current !== message.id) return;
          resetSend(message.reason || "The receiver declined the photo.");
          break;
        }
      }
    },
    // streamPendingFile is declared below and read through a ref-free closure at call time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clearReleaseTimer, incomingMeta, resetReceive, resetSend]
  );

  const streamPendingFileRef = useRef<() => Promise<void>>(async () => {});

  async function streamPendingFile() {
    await streamPendingFileRef.current();
  }

  useEffect(() => {
    streamPendingFileRef.current = async () => {
      const channel = channelRef.current;
      const file = fileRef.current;
      const id = sendIdRef.current;
      if (!channel || !file || !id) return;

      const signal = cancelRef.current;
      setSentBytes(0);
      try {
        await sendFile(channel, file, {
          signal,
          onProgress: (sent) => setSentBytes(sent),
        });
        if (signal.cancelled) return;
        sendControl(channel, { kind: "DONE", id });
      } catch (err) {
        if (signal.cancelled) return;
        resetSend(
          err instanceof Error && err.message === "Peer disconnected"
            ? "Peer disconnected. Your photo is still here."
            : "Transfer stopped. Your photo is still here."
        );
      }
    };
  }, [resetSend]);

  /* ---------- peer connection ---------- */

  useEffect(() => {
    if (!role) return;

    const session = startPeer(code, role, {
      onStatus: (next, detail) => {
        setStatus(next);
        setStatusDetail(detail ?? null);
        if (next === "failed" || next === "closed") {
          setChannelOpen(false);
          // A drop mid-transfer must not leave either side spinning.
          resetSend("Peer disconnected. Your photo is still here.");
          resetReceive();
        }
      },
      onChannelOpen: (channel) => {
        channelRef.current = channel;
        setChannelOpen(true);
        channel.onmessage = (event) => {
          if (typeof event.data === "string") {
            const parsed = parseControl(event.data);
            if (parsed) handleControl(parsed);
            return;
          }
          const receiver = receiverRef.current;
          if (!receiver) return;
          const chunk =
            event.data instanceof ArrayBuffer ? event.data : new Uint8Array(event.data).buffer;
          const { received } = receiver.push(chunk);
          setRecvBytes(received);
        };
      },
      onChannelClose: () => {
        setChannelOpen(false);
        channelRef.current = null;
      },
    });

    return () => session.close();
  }, [code, role, handleControl, resetReceive, resetSend]);

  /* ---------- leave on unmount ---------- */

  useEffect(() => {
    if (!role) return;
    const onUnload = () => void leaveRoom(code, role);
    window.addEventListener("pagehide", onUnload);
    return () => window.removeEventListener("pagehide", onUnload);
  }, [code, role]);

  useEffect(() => {
    return () => {
      if (incoming) URL.revokeObjectURL(incoming.url);
    };
  }, [incoming]);

  /* ---------- sender actions ---------- */

  const handleGrab = useCallback(() => {
    const channel = channelRef.current;
    const file = fileRef.current;
    if (!channel || channel.readyState !== "open" || !file) return;

    // Grabbing again replaces a pending photo; tell the peer before re-announcing.
    if (sendIdRef.current) {
      sendControl(channel, {
        kind: "CANCEL",
        id: sendIdRef.current,
        reason: "The sender picked a different photo.",
      });
    }

    const id = newTransferId();
    sendIdRef.current = id;
    cancelRef.current = { cancelled: false };
    setGrabAnimating(true);
    setSendPhase("pending");
    setNotice(null);

    sendControl(channel, {
      kind: "META",
      id,
      name: file.name,
      size: file.size,
      type: file.type,
    });

    clearReleaseTimer();
    releaseTimerRef.current = setTimeout(() => {
      const pendingId = sendIdRef.current;
      if (!pendingId) return;
      const live = channelRef.current;
      if (live) {
        sendControl(live, { kind: "CANCEL", id: pendingId, reason: "Nobody opened a palm in time." });
      }
      resetSend("Nobody opened a palm within 60 seconds. Grab again when you are ready.");
    }, RELEASE_TIMEOUT_MS);
  }, [clearReleaseTimer, resetSend]);

  /* ---------- receiver actions ---------- */

  const acceptIncoming = useCallback(() => {
    acceptedPeerRef.current = true;
    setRecvPhase("waiting-release");
  }, []);

  const declineIncoming = useCallback(() => {
    const channel = channelRef.current;
    if (channel && incomingMeta) {
      sendControl(channel, { kind: "REJECT", id: incomingMeta.id, reason: "The receiver declined." });
    }
    resetReceive("Photo declined.");
  }, [incomingMeta, resetReceive]);

  const handleRelease = useCallback(() => {
    const channel = channelRef.current;
    if (!channel || channel.readyState !== "open" || !incomingMeta) return;
    receiverRef.current = new FileReceiver(incomingMeta);
    setRecvBytes(0);
    setRecvPhase("receiving");
    sendControl(channel, { kind: "READY", id: incomingMeta.id });
  }, [incomingMeta]);

  const handleSave = useCallback(async () => {
    if (!incoming) return;
    try {
      const how = await saveFile(incoming.blob, incoming.meta.name);
      setNotice(how === "shared" ? "Shared." : "Saved to your downloads.");
    } catch {
      setNotice("Could not save the photo. Long-press the image to save it instead.");
    }
  }, [incoming]);

  function handleLeave() {
    if (role) void leaveRoom(code, role);
    router.push("/");
  }

  /* ---------- derived UI state ---------- */

  const connected = status === "connected" && channelOpen;
  const gestureActive =
    connected &&
    ((sendPhase === "grabbing" && Boolean(fileRef.current)) || recvPhase === "waiting-release");
  const gestureTarget = recvPhase === "waiting-release" ? "Open_Palm" : "Closed_Fist";

  const statusLine = !role
    ? "Joining room…"
    : status === "failed"
      ? (statusDetail ?? "Connection failed.")
      : status === "closed"
        ? "Peer disconnected."
        : connected
          ? "Connected to peer"
          : "Waiting for peer";

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-5 px-5 py-6">
      <header className="flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-widest text-zinc-500">Room</p>
          <p className="text-3xl font-semibold tracking-[0.3em]">{code}</p>
        </div>
        <button
          type="button"
          onClick={handleLeave}
          className="rounded-xl bg-zinc-800 px-4 py-2 text-sm text-zinc-300 transition hover:bg-zinc-700"
        >
          Leave
        </button>
      </header>

      <div
        className={`rounded-2xl border px-4 py-3 text-center text-base font-medium ${
          connected
            ? "border-emerald-700/50 bg-emerald-950/40 text-emerald-300"
            : status === "failed"
              ? "border-red-800/50 bg-red-950/40 text-red-300"
              : "border-zinc-800 bg-zinc-900/60 text-zinc-300"
        }`}
      >
        {statusLine}
      </div>

      {statusDetail && status !== "failed" && (
        <p className="text-center text-sm text-amber-400">{statusDetail}</p>
      )}

      {/* Waiting room: show the code and QR so the other phone can join. */}
      {!connected && status !== "failed" && (
        <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 text-center">
          <p className="text-sm text-zinc-400">Scan this, or type the code on the other phone.</p>
          {qr && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qr} alt={`QR code for room ${code}`} className="mx-auto mt-4 h-48 w-48 rounded-xl" />
          )}
          {joinUrl && <p className="mt-3 break-all text-xs text-zinc-600">{joinUrl}</p>}
        </section>
      )}

      {notice && (
        <p role="status" className="rounded-xl bg-zinc-900 px-4 py-3 text-center text-sm text-zinc-300">
          {notice}
        </p>
      )}

      {/* ---------- receiving side ---------- */}

      {connected && recvPhase === "prompting" && incomingMeta && (
        <section className="rounded-2xl border border-emerald-800/60 bg-emerald-950/30 p-4">
          <p className="text-base font-medium text-emerald-200">Your peer wants to send a photo</p>
          <p className="mt-1 text-sm text-zinc-400">
            {incomingMeta.name} · {formatBytes(incomingMeta.size)}
          </p>
          <div className="mt-4 flex gap-3">
            <button
              type="button"
              onClick={acceptIncoming}
              className="flex-1 rounded-xl bg-emerald-600 px-4 py-3 font-medium text-white transition hover:bg-emerald-500"
            >
              Accept
            </button>
            <button
              type="button"
              onClick={declineIncoming}
              className="flex-1 rounded-xl bg-zinc-800 px-4 py-3 font-medium text-zinc-200 transition hover:bg-zinc-700"
            >
              Decline
            </button>
          </div>
        </section>
      )}

      {connected && recvPhase === "waiting-release" && incomingMeta && (
        <CameraGesture
          target="Open_Palm"
          active={gestureActive && gestureTarget === "Open_Palm"}
          prompt="Photo incoming — open your palm"
          fallbackLabel="Receive without gesture"
          onDetected={handleRelease}
          onFallback={handleRelease}
        />
      )}

      {connected && recvPhase === "receiving" && incomingMeta && (
        <TransferProgress label="Receiving" sent={recvBytes} total={incomingMeta.size} />
      )}

      {recvPhase === "done" && incoming && (
        <section className="space-y-3 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={incoming.url}
            alt={incoming.meta.name}
            className="max-h-72 w-full rounded-xl object-contain"
          />
          <p className="text-center text-xs text-zinc-500">
            {incoming.meta.name} · {formatBytes(incoming.meta.size)}
          </p>
          <button
            type="button"
            onClick={handleSave}
            className="w-full rounded-xl bg-emerald-600 px-4 py-4 text-base font-semibold text-white transition hover:bg-emerald-500"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              URL.revokeObjectURL(incoming.url);
              setIncoming(null);
              setRecvPhase("idle");
            }}
            className="w-full rounded-xl bg-zinc-800 px-4 py-3 text-sm text-zinc-300 transition hover:bg-zinc-700"
          >
            Done
          </button>
        </section>
      )}

      {/* ---------- sending side ---------- */}

      {connected && recvPhase !== "receiving" && recvPhase !== "waiting-release" && (
        <section className="space-y-3">
          <div className={grabAnimating ? "animate-grab" : undefined} onAnimationEnd={() => setGrabAnimating(false)}>
            <PhotoPicker
              disabled={sendPhase === "sending"}
              onPicked={(file) => {
                fileRef.current = file;
                setSelectedName(file.name);
                setNotice(null);
                setSendPhase("grabbing");
              }}
              onError={(message) => setNotice(message)}
            />
          </div>

          {sendPhase === "grabbing" && fileRef.current && (
            <CameraGesture
              target="Closed_Fist"
              active={gestureActive && gestureTarget === "Closed_Fist"}
              prompt="Make a fist to grab"
              fallbackLabel="Send without gesture"
              onDetected={handleGrab}
              onFallback={handleGrab}
            />
          )}

          {sendPhase === "pending" && (
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 text-center">
              <p className="text-base font-medium text-zinc-100">Photo grabbed</p>
              <p className="mt-1 text-sm text-zinc-400">
                Waiting for your peer to open a palm{selectedName ? ` · ${selectedName}` : ""}
              </p>
              <button
                type="button"
                onClick={() => {
                  const channel = channelRef.current;
                  if (channel && sendIdRef.current) {
                    sendControl(channel, {
                      kind: "CANCEL",
                      id: sendIdRef.current,
                      reason: "The sender cancelled.",
                    });
                  }
                  resetSend("Grab cancelled.");
                }}
                className="mt-4 w-full rounded-xl bg-zinc-800 px-4 py-3 text-sm text-zinc-300 transition hover:bg-zinc-700"
              >
                Cancel
              </button>
            </div>
          )}

          {sendPhase === "sending" && fileRef.current && (
            <TransferProgress label="Sending" sent={sentBytes} total={fileRef.current.size} />
          )}
        </section>
      )}

      <p className="mt-auto pt-4 text-center text-xs text-zinc-600">
        Up to {formatBytes(MAX_FILE_BYTES)} per photo · location data is stripped before sending
      </p>
    </main>
  );
}

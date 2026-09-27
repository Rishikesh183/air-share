"use client";

import {
  Role,
  addCandidate,
  setAnswer,
  setOffer,
  watchCandidates,
  watchRoom,
} from "./signaling";

export const CONNECT_TIMEOUT_MS = 15000;
export const CONNECT_FAILED_MESSAGE =
  "Couldn't connect directly. Try same Wi-Fi or mobile hotspot.";

export type PeerStatus = "connecting" | "connected" | "failed" | "closed";

export interface PeerHandlers {
  onStatus: (status: PeerStatus, detail?: string) => void;
  onChannelOpen: (channel: RTCDataChannel) => void;
  onChannelClose: () => void;
}

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

export interface PeerSession {
  pc: RTCPeerConnection;
  close: () => void;
}

/**
 * Wires a peer connection to the Firebase signaling room.
 * The host creates the data channel and the offer; the guest answers.
 */
export function startPeer(code: string, role: Role, handlers: PeerHandlers): PeerSession {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const unsubscribers: Array<() => void> = [];
  let closed = false;
  let settled = false;
  let remoteDescriptionSet = false;
  let offerCreated = false;
  let answerCreated = false;
  const pendingCandidates: RTCIceCandidateInit[] = [];

  const remoteRole: Role = role === "host" ? "guest" : "host";

  const timeout = setTimeout(() => {
    if (!settled && !closed) {
      settled = true;
      handlers.onStatus("failed", CONNECT_FAILED_MESSAGE);
    }
  }, CONNECT_TIMEOUT_MS);

  function cleanup() {
    if (closed) return;
    closed = true;
    clearTimeout(timeout);
    unsubscribers.forEach((fn) => {
      try {
        fn();
      } catch {
        /* listener already detached */
      }
    });
    try {
      pc.close();
    } catch {
      /* already closed */
    }
  }

  function bindChannel(channel: RTCDataChannel) {
    channel.binaryType = "arraybuffer";
    channel.onopen = () => {
      settled = true;
      clearTimeout(timeout);
      handlers.onStatus("connected");
      handlers.onChannelOpen(channel);
    };
    channel.onclose = () => handlers.onChannelClose();
  }

  if (role === "host") {
    bindChannel(pc.createDataChannel("gesturedrop", { ordered: true }));
  } else {
    pc.ondatachannel = (event) => bindChannel(event.channel);
  }

  pc.onicecandidate = (event) => {
    if (event.candidate) void addCandidate(code, role, event.candidate.toJSON());
  };

  pc.onconnectionstatechange = () => {
    if (closed) return;
    if (pc.connectionState === "failed") {
      settled = true;
      clearTimeout(timeout);
      handlers.onStatus("failed", CONNECT_FAILED_MESSAGE);
    } else if (pc.connectionState === "disconnected") {
      handlers.onStatus("closed", "Peer disconnected.");
    }
  };

  async function drainCandidates() {
    while (pendingCandidates.length) {
      const candidate = pendingCandidates.shift()!;
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        // A candidate can be stale after renegotiation; ignore it.
      }
    }
  }

  unsubscribers.push(
    watchCandidates(code, remoteRole, (candidate) => {
      if (closed) return;
      if (!remoteDescriptionSet) {
        pendingCandidates.push(candidate);
        return;
      }
      void pc.addIceCandidate(candidate).catch(() => undefined);
    })
  );

  unsubscribers.push(
    watchRoom(code, (room) => {
      if (closed || !room) return;

      void (async () => {
        try {
          if (role === "host") {
            // Host waits for the guest, then offers.
            if (room.guestUid && !offerCreated) {
              offerCreated = true;
              const offer = await pc.createOffer();
              await pc.setLocalDescription(offer);
              await setOffer(code, { type: offer.type, sdp: offer.sdp });
            }
            if (room.answer && !pc.currentRemoteDescription) {
              await pc.setRemoteDescription(new RTCSessionDescription(room.answer));
              remoteDescriptionSet = true;
              await drainCandidates();
            }
          } else {
            if (room.offer && !answerCreated) {
              answerCreated = true;
              await pc.setRemoteDescription(new RTCSessionDescription(room.offer));
              remoteDescriptionSet = true;
              await drainCandidates();
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              await setAnswer(code, { type: answer.type, sdp: answer.sdp });
            }
          }
        } catch (err) {
          if (closed) return;
          settled = true;
          clearTimeout(timeout);
          handlers.onStatus("failed", err instanceof Error ? err.message : CONNECT_FAILED_MESSAGE);
        }
      })();
    })
  );

  handlers.onStatus("connecting");

  return { pc, close: cleanup };
}

"use client";

import { FilesetResolver, GestureRecognizer } from "@mediapipe/tasks-vision";
import { useCallback, useEffect, useRef, useState } from "react";

export const HOLD_MS = 500; // gesture must stay continuous this long
export const COOLDOWN_MS = 1500; // ignore triggers for this long afterwards
export const MIN_CONFIDENCE = 0.7;

const WASM_PATH = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task";

export type TargetGesture = "Closed_Fist" | "Open_Palm";

export type CameraState = "idle" | "loading" | "running" | "denied" | "unsupported" | "error";

export interface UseGestureResult {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  cameraState: CameraState;
  /** Label of the gesture currently seen, e.g. "Open_Palm 93%" or "None". */
  detected: string;
  /** 0..1 fraction of the 500 ms hold completed. */
  holdProgress: number;
  error: string | null;
  start: () => void;
  stop: () => void;
}

/**
 * Runs MediaPipe GestureRecognizer on the front camera and calls `onDetected`
 * once the target gesture is held continuously for HOLD_MS.
 * The camera only runs between start() and stop() so it does not drain battery.
 */
export function useGesture(
  targetGesture: TargetGesture,
  onDetected: () => void
): UseGestureResult {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recognizerRef = useRef<GestureRecognizer | null>(null);
  const rafRef = useRef<number | null>(null);
  const holdStartRef = useRef<number | null>(null);
  const cooldownUntilRef = useRef(0);
  const lastVideoTimeRef = useRef(-1);
  const activeRef = useRef(false);
  const wasRunningRef = useRef(false);
  const callbackRef = useRef(onDetected);
  const targetRef = useRef<TargetGesture>(targetGesture);

  const [cameraState, setCameraState] = useState<CameraState>("idle");
  const [detected, setDetected] = useState("None");
  const [holdProgress, setHoldProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    callbackRef.current = onDetected;
  }, [onDetected]);

  useEffect(() => {
    targetRef.current = targetGesture;
    holdStartRef.current = null;
    setHoldProgress(0);
  }, [targetGesture]);

  const stop = useCallback(() => {
    activeRef.current = false;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    holdStartRef.current = null;
    lastVideoTimeRef.current = -1;
    setDetected("None");
    setHoldProgress(0);
    setCameraState((prev) => (prev === "denied" || prev === "unsupported" ? prev : "idle"));
  }, []);

  const loop = useCallback(() => {
    if (!activeRef.current) return;
    const video = videoRef.current;
    const recognizer = recognizerRef.current;

    if (
      video &&
      recognizer &&
      video.readyState >= 2 &&
      video.currentTime !== lastVideoTimeRef.current
    ) {
      lastVideoTimeRef.current = video.currentTime;
      try {
        const result = recognizer.recognizeForVideo(video, performance.now());
        const top = result.gestures?.[0]?.[0];
        const name = top?.categoryName ?? "None";
        const score = top?.score ?? 0;
        setDetected(name === "None" ? "None" : `${name} ${(score * 100).toFixed(0)}%`);

        const isTarget = name === targetRef.current && score >= MIN_CONFIDENCE;
        const now = performance.now();

        if (isTarget && now >= cooldownUntilRef.current) {
          if (holdStartRef.current === null) holdStartRef.current = now;
          const held = now - holdStartRef.current;
          setHoldProgress(Math.min(1, held / HOLD_MS));
          if (held >= HOLD_MS) {
            holdStartRef.current = null;
            cooldownUntilRef.current = now + COOLDOWN_MS;
            setHoldProgress(0);
            callbackRef.current();
          }
        } else {
          holdStartRef.current = null;
          setHoldProgress(0);
        }
      } catch {
        // A single dropped frame is not fatal; keep the loop alive.
      }
    }

    rafRef.current = requestAnimationFrame(loop);
  }, []);

  const start = useCallback(() => {
    if (activeRef.current) return;

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setCameraState("unsupported");
      setError("This browser has no camera access. Use the fallback button.");
      return;
    }

    activeRef.current = true;
    setError(null);
    setCameraState("loading");

    void (async () => {
      try {
        if (!recognizerRef.current) {
          const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
          recognizerRef.current = await GestureRecognizer.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
            runningMode: "VIDEO",
            numHands: 1,
          });
        }
        if (!activeRef.current) return;

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false,
        });
        if (!activeRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          video.muted = true;
          video.playsInline = true;
          await video.play().catch(() => undefined);
        }

        setCameraState("running");
        rafRef.current = requestAnimationFrame(loop);
      } catch (err) {
        activeRef.current = false;
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;

        const name = err instanceof DOMException ? err.name : "";
        if (name === "NotAllowedError" || name === "SecurityError") {
          setCameraState("denied");
          setError("Camera permission denied. Use the fallback button below.");
        } else if (name === "NotFoundError") {
          setCameraState("unsupported");
          setError("No camera found. Use the fallback button below.");
        } else {
          setCameraState("error");
          setError(err instanceof Error ? err.message : "Could not start the camera.");
        }
      }
    })();
  }, [loop]);

  // Pause the camera while the tab is hidden, resume when it comes back.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        if (activeRef.current) {
          wasRunningRef.current = true;
          stop();
        }
      } else if (wasRunningRef.current) {
        wasRunningRef.current = false;
        start();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [start, stop]);

  useEffect(() => stop, [stop]);

  useEffect(() => {
    return () => {
      recognizerRef.current?.close();
      recognizerRef.current = null;
    };
  }, []);

  return { videoRef, cameraState, detected, holdProgress, error, start, stop };
}

/** Keeps the screen awake while in a room, when the browser supports it. */
export function useWakeLock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return;

    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const request = async () => {
      try {
        sentinel = await navigator.wakeLock.request("screen");
      } catch {
        // Denied or unsupported: the screen just dims as usual.
      }
    };

    const onVisibility = () => {
      if (!document.hidden && !cancelled) void request();
    };

    void request();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      void sentinel?.release().catch(() => undefined);
    };
  }, [enabled]);
}

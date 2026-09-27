"use client";

import { useEffect } from "react";
import { TargetGesture, useGesture } from "@/lib/gestures";

interface CameraGestureProps {
  target: TargetGesture;
  active: boolean;
  prompt: string;
  fallbackLabel: string;
  onDetected: () => void;
  onFallback: () => void;
}

const GESTURE_LABEL: Record<TargetGesture, string> = {
  Closed_Fist: "Make a fist to grab",
  Open_Palm: "Open your palm to receive",
};

/**
 * Small corner camera preview plus the live gesture label.
 * Starts the camera only while `active`, and always offers a no-camera fallback.
 */
export default function CameraGesture({
  target,
  active,
  prompt,
  fallbackLabel,
  onDetected,
  onFallback,
}: CameraGestureProps) {
  const { videoRef, cameraState, detected, holdProgress, error, start, stop } = useGesture(
    target,
    onDetected
  );

  useEffect(() => {
    if (active) start();
    else stop();
  }, [active, start, stop]);

  if (!active) return null;

  const showFallback =
    cameraState === "denied" || cameraState === "unsupported" || cameraState === "error";

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
      <p className="text-center text-lg font-medium text-zinc-100">
        {prompt || GESTURE_LABEL[target]}
      </p>

      <div className="mt-4 flex items-center gap-4">
        <div className="relative h-28 w-28 shrink-0 overflow-hidden rounded-xl border border-zinc-700 bg-black">
          <video
            ref={videoRef}
            className="h-full w-full -scale-x-100 object-cover"
            playsInline
            muted
            autoPlay
          />
          {cameraState === "loading" && (
            <div className="absolute inset-0 grid place-items-center bg-black/70 text-xs text-zinc-300">
              Loading…
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-xs uppercase tracking-wide text-zinc-500">Detected</p>
          <p className="truncate text-base font-medium text-zinc-200">{detected}</p>

          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full bg-emerald-500 transition-[width] duration-75"
              style={{ width: `${Math.round(holdProgress * 100)}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            Hold {target.replace("_", " ")} for half a second
          </p>
        </div>
      </div>

      {error && <p className="mt-3 text-sm text-amber-400">{error}</p>}

      <button
        type="button"
        onClick={onFallback}
        className={`mt-4 w-full rounded-xl px-4 py-3 text-base font-medium transition ${
          showFallback
            ? "bg-emerald-600 text-white hover:bg-emerald-500"
            : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
        }`}
      >
        {fallbackLabel}
      </button>
    </div>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import NearbyDevices from "@/components/NearbyDevices";
import { ensureSignedIn, isFirebaseConfigured } from "@/lib/firebase";
import {
  RoomFullError,
  RoomMissingError,
  createRoom,
  joinRoom,
} from "@/lib/signaling";

export default function HomePage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"create" | "join" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [configured, setConfigured] = useState(true);

  useEffect(() => {
    if (!isFirebaseConfigured()) {
      setConfigured(false);
      return;
    }
    // Warm up anonymous auth so the first tap is fast.
    ensureSignedIn().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : "Sign-in failed.")
    );
  }, []);

  async function handleCreate() {
    setError(null);
    setBusy("create");
    try {
      const { code: newCode } = await createRoom();
      router.push(`/room/${newCode}?role=host`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create a room.");
      setBusy(null);
    }
  }

  async function handleJoin() {
    const trimmed = code.trim();
    if (!/^\d{4}$/.test(trimmed)) {
      setError("Enter the 4-digit code.");
      return;
    }
    setError(null);
    setBusy("join");
    try {
      await joinRoom(trimmed);
      router.push(`/room/${trimmed}?role=guest`);
    } catch (err) {
      if (err instanceof RoomFullError) setError("Room full.");
      else if (err instanceof RoomMissingError) setError(err.message);
      else setError(err instanceof Error ? err.message : "Could not join that room.");
      setBusy(null);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-8 px-5 py-10">
      <header className="text-center">
        <h1 className="text-3xl font-semibold tracking-tight">GestureDrop</h1>
        <p className="mt-2 text-sm text-zinc-400">
          Grab a photo with a fist. Drop it into an open palm.
        </p>
      </header>

      {!configured && (
        <div className="rounded-xl border border-amber-700/50 bg-amber-950/40 p-4 text-sm text-amber-200">
          Firebase is not configured. Copy <code>.env.example</code> to <code>.env.local</code>,
          fill in the five <code>NEXT_PUBLIC_FIREBASE_*</code> values, then restart the dev server.
        </div>
      )}

      {configured && <NearbyDevices />}

      <section className="space-y-3">
        {configured && (
          <p className="text-center text-xs uppercase tracking-widest text-zinc-600">
            Or use a room code
          </p>
        )}
        <button
          type="button"
          onClick={handleCreate}
          disabled={!configured || busy !== null}
          className="w-full rounded-2xl bg-emerald-600 px-4 py-5 text-lg font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-40"
        >
          {busy === "create" ? "Creating room…" : "Create room"}
        </button>

        <div className="flex items-center gap-3 py-1 text-xs uppercase tracking-widest text-zinc-600">
          <span className="h-px flex-1 bg-zinc-800" />
          or
          <span className="h-px flex-1 bg-zinc-800" />
        </div>

        <input
          inputMode="numeric"
          pattern="\d*"
          maxLength={4}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 4))}
          placeholder="1234"
          aria-label="Room code"
          className="w-full rounded-2xl border border-zinc-800 bg-zinc-900 px-4 py-5 text-center text-3xl tracking-[0.5em] text-zinc-100 outline-none focus:border-emerald-600"
        />
        <button
          type="button"
          onClick={handleJoin}
          disabled={!configured || busy !== null}
          className="w-full rounded-2xl bg-zinc-800 px-4 py-5 text-lg font-semibold text-zinc-100 transition hover:bg-zinc-700 disabled:opacity-40"
        >
          {busy === "join" ? "Joining…" : "Join room"}
        </button>
      </section>

      {error && (
        <p role="alert" className="text-center text-sm text-red-400">
          {error}
        </p>
      )}

      <p className="text-center text-xs text-zinc-600">
        Photos travel directly between the two phones. Nothing is uploaded to a server.
      </p>
    </main>
  );
}

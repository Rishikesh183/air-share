"use client";

import { useEffect, useRef, useState } from "react";
import { MAX_FILE_BYTES, formatBytes, stripExif } from "@/lib/transfer";

interface PhotoPickerProps {
  disabled?: boolean;
  /** Receives the EXIF-stripped file, ready to send. */
  onPicked: (file: File) => void;
  onError: (message: string) => void;
}

/** File input + preview. Strips EXIF before handing the file up. */
export default function PhotoPicker({ disabled, onPicked, onError }: PhotoPickerProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  async function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow picking the same file again
    if (!file) return;

    if (file.size > MAX_FILE_BYTES) {
      onError(`That photo is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_FILE_BYTES)}.`);
      return;
    }

    setBusy(true);
    try {
      const clean = await stripExif(file);
      if (clean.size > MAX_FILE_BYTES) {
        onError(`That photo is ${formatBytes(clean.size)} after processing. The limit is ${formatBytes(MAX_FILE_BYTES)}.`);
        return;
      }
      setPreview((old) => {
        if (old) URL.revokeObjectURL(old);
        return URL.createObjectURL(clean);
      });
      onPicked(clean);
    } catch {
      onError("Unsupported format");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleChange}
      />
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => inputRef.current?.click()}
        className="w-full rounded-xl bg-zinc-800 px-4 py-4 text-base font-medium text-zinc-100 transition hover:bg-zinc-700 disabled:opacity-40"
      >
        {busy ? "Preparing photo…" : preview ? "Pick another photo" : "Pick photo"}
      </button>

      {preview && (
        // A blob: preview does not benefit from next/image optimisation.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={preview}
          alt="Selected photo"
          className="max-h-64 w-full rounded-xl object-contain"
        />
      )}
    </div>
  );
}

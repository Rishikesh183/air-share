"use client";

export const CHUNK_SIZE = 16 * 1024; // 16 KB
export const BUFFER_HIGH_WATER = 1024 * 1024; // pause above 1 MB
export const BUFFER_LOW_WATER = 256 * 1024;
export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB in v1
export const RELEASE_TIMEOUT_MS = 60_000; // auto-cancel an unreleased grab

export interface FileMeta {
  id: string;
  name: string;
  size: number;
  type: string;
}

export type ControlMessage =
  | ({ kind: "META" } & FileMeta)
  | { kind: "READY"; id: string }
  | { kind: "DONE"; id: string }
  | { kind: "ACK"; id: string }
  | { kind: "CANCEL"; id: string; reason: string }
  | { kind: "REJECT"; id: string; reason: string };

export function newTransferId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function sendControl(channel: RTCDataChannel, message: ControlMessage): void {
  if (channel.readyState !== "open") return;
  channel.send(JSON.stringify(message));
}

export function parseControl(data: string): ControlMessage | null {
  try {
    const parsed = JSON.parse(data) as ControlMessage;
    return parsed && typeof parsed.kind === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Re-encodes an image through a canvas, which drops EXIF (including GPS) along the way.
 * Throws "Unsupported format" when the browser cannot decode the file (e.g. HEIC on Chrome).
 */
export async function stripExif(file: File): Promise<File> {
  const bitmap = await decodeImage(file);

  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Unsupported format");
  ctx.drawImage(bitmap, 0, 0);
  if ("close" in bitmap && typeof bitmap.close === "function") bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.92)
  );
  if (!blob) throw new Error("Unsupported format");

  const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
  return new File([blob], name, { type: "image/jpeg", lastModified: Date.now() });
}

async function decodeImage(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      // Fall through to the <img> path; some browsers decode there but not here.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Unsupported format"));
      img.src = url;
    });
  } finally {
    // The bitmap is already drawn by the time the caller finishes with it.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

export interface SendOptions {
  onProgress?: (sent: number, total: number) => void;
  signal?: { cancelled: boolean };
}

/** Streams a file as 16 KB binary chunks, honouring data-channel backpressure. */
export async function sendFile(
  channel: RTCDataChannel,
  file: File,
  options: SendOptions = {}
): Promise<void> {
  channel.bufferedAmountLowThreshold = BUFFER_LOW_WATER;

  let offset = 0;
  while (offset < file.size) {
    if (options.signal?.cancelled) throw new Error("Transfer cancelled");
    if (channel.readyState !== "open") throw new Error("Peer disconnected");

    if (channel.bufferedAmount > BUFFER_HIGH_WATER) {
      await waitForDrain(channel);
      continue;
    }

    const slice = file.slice(offset, offset + CHUNK_SIZE);
    const buffer = await slice.arrayBuffer();
    channel.send(buffer);
    offset += buffer.byteLength;
    options.onProgress?.(offset, file.size);
  }
}

function waitForDrain(channel: RTCDataChannel): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      channel.removeEventListener("bufferedamountlow", done);
      clearTimeout(timer);
      resolve();
    };
    // A closed channel never fires the event, so cap the wait.
    const timer = setTimeout(done, 2000);
    channel.addEventListener("bufferedamountlow", done);
  });
}

/** Collects incoming chunks for one file and reports progress. */
export class FileReceiver {
  private chunks: ArrayBuffer[] = [];
  private received = 0;

  constructor(public readonly meta: FileMeta) {}

  push(chunk: ArrayBuffer): { received: number; total: number } {
    this.chunks.push(chunk);
    this.received += chunk.byteLength;
    return { received: this.received, total: this.meta.size };
  }

  get bytesReceived(): number {
    return this.received;
  }

  toBlob(): Blob {
    return new Blob(this.chunks, { type: this.meta.type || "image/jpeg" });
  }
}

/** Saves via the Web Share API when files are supported, otherwise a download link. */
export async function saveFile(blob: Blob, name: string): Promise<"shared" | "downloaded"> {
  const type = blob.type || "image/jpeg";
  const file = new File([blob], name, { type });

  if (typeof navigator !== "undefined" && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return "shared";
    } catch (err) {
      // User dismissed the sheet, or sharing is blocked: fall back to a download.
      if (err instanceof DOMException && err.name === "AbortError") return "shared";
    }
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return "downloaded";
}

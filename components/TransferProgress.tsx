"use client";

import { formatBytes } from "@/lib/transfer";

interface TransferProgressProps {
  label: string;
  sent: number;
  total: number;
}

export default function TransferProgress({ label, sent, total }: TransferProgressProps) {
  const pct = total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : 0;

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="flex items-baseline justify-between">
        <p className="text-base font-medium text-zinc-100">
          {label} {pct}%
        </p>
        <p className="text-xs text-zinc-500">
          {formatBytes(sent)} / {formatBytes(total)}
        </p>
      </div>
      <div className="mt-3 h-3 w-full overflow-hidden rounded-full bg-zinc-800">
        <div
          className="h-full bg-emerald-500 transition-[width] duration-150"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

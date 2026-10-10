"use client";

import type { ClientConfig } from "@/lib/types";

export function ScaffoldStatus({ config }: { config: ClientConfig }) {
  return <p className="text-sm text-slate-600">Mode: {config.mode}. No model calls are implemented.</p>;
}

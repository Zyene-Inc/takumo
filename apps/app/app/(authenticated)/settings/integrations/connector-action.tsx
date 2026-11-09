"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export const useAction = () => {
  const router = useRouter();
  const [message, setMessage] = useState<{
    error: boolean;
    text: string;
  } | null>(null);
  const [pending, start] = useTransition();
  const run = (
    fn: () => Promise<
      { ok: boolean; error?: string } & Record<string, unknown>
    >,
    done?: (r: Record<string, unknown>) => string | null
  ) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        const text = done?.(r) ?? null;
        setMessage(text ? { error: false, text } : null);
        router.refresh();
      } else {
        setMessage({ error: true, text: r.error ?? "Something went wrong." });
      }
    });
  return { message, pending, run, start, setMessage };
};

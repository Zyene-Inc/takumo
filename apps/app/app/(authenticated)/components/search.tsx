"use client";

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { SearchIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/** The header's search button: opens a search box (also on ⌘K / Ctrl+K). */
export const Search = () => {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <button
        aria-label="Search"
        className="flex h-7 items-center gap-2 rounded-md px-2 text-[12.5px] text-slate-500 transition-colors hover:bg-slate-200/60 hover:text-slate-900"
        onClick={() => setOpen(true)}
        type="button"
      >
        <SearchIcon className="size-3.5" />
        <span className="hidden xl:inline">Search</span>
        <kbd className="ml-0.5 hidden h-4 items-center rounded border border-slate-300/70 bg-white/60 px-1 font-mono text-[10px] text-slate-500 xl:inline-flex">
          ⌘K
        </kbd>
      </button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent
          className="top-[20%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-lg"
          showCloseButton={false}
        >
          <DialogTitle className="sr-only">Search</DialogTitle>
          <form
            className="flex h-12 items-center gap-2.5 px-4"
            onSubmit={(event) => {
              event.preventDefault();
              const q = new FormData(event.currentTarget).get("q");
              if (typeof q === "string" && q.trim()) {
                setOpen(false);
                router.push(`/search?q=${encodeURIComponent(q.trim())}`);
              }
            }}
          >
            <SearchIcon className="size-4 shrink-0 text-slate-400" />
            <input
              aria-label="Search"
              autoFocus
              className="h-full flex-1 bg-transparent text-[13.5px] text-slate-900 outline-none placeholder:text-slate-400"
              name="q"
              placeholder="Search parts by number or description…"
              type="search"
            />
            <kbd className="rounded border border-slate-200 px-1 font-mono text-[10px] text-slate-400">
              Enter
            </kbd>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
};

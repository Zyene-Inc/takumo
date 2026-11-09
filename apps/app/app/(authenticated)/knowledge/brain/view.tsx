"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { cn } from "@repo/design-system/lib/utils";
import { ArrowUpRightIcon, MessageSquareIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import {
  BRAIN_TYPE_COLOR,
  BRAIN_TYPE_LABEL,
  BRAIN_TYPES,
  type Brain,
  type BrainType,
} from "@/lib/knowledge/brain";
import { BrainCanvas, type BrainMode } from "./canvas";

export const BrainView = ({ brain }: { brain: Brain }) => {
  const [mode, setMode] = useState<BrainMode>("globe");
  const [hidden, setHidden] = useState<Set<BrainType>>(new Set());
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hover, setHover] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);

  const counts = useMemo(() => {
    const c = new Map<BrainType, number>();
    for (const n of brain.nodes) {
      c.set(n.type, (c.get(n.type) ?? 0) + 1);
    }
    return c;
  }, [brain]);
  const present = BRAIN_TYPES.filter((t) => counts.has(t));

  const { nodes, links } = useMemo(() => {
    const kept = brain.nodes.filter((n) => !hidden.has(n.type));
    const ids = new Set(kept.map((n) => n.id));
    return {
      nodes: kept,
      links: brain.links.filter((l) => ids.has(l.source) && ids.has(l.target)),
    };
  }, [brain, hidden]);

  const byId = useMemo(
    () => new Map(brain.nodes.map((n) => [n.id, n])),
    [brain]
  );

  const term = search.trim().toLowerCase();
  const matchIds = useMemo(() => {
    if (!term) {
      return null;
    }
    return new Set(
      nodes
        .filter(
          (n) =>
            n.label.toLowerCase().includes(term) ||
            n.sub?.toLowerCase().includes(term)
        )
        .map((n) => n.id)
    );
  }, [nodes, term]);

  const selected = selectedId ? byId.get(selectedId) : undefined;
  const connections = useMemo(() => {
    if (!selectedId) {
      return [];
    }
    return links
      .filter((l) => l.source === selectedId || l.target === selectedId)
      .map((l) => {
        const other = byId.get(l.source === selectedId ? l.target : l.source);
        return other ? { node: other, label: l.label } : null;
      })
      .filter((c) => c !== null)
      .sort((a, b) => b.node.degree - a.node.degree);
  }, [links, byId, selectedId]);
  const hovered = hover ? byId.get(hover.id) : undefined;

  const toggle = (type: BrainType) => {
    setHidden((h) => {
      const next = new Set(h);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
    setSelectedId(null);
  };

  const pickFirstMatch = () => {
    const first = matchIds && nodes.find((n) => matchIds.has(n.id));
    if (first) {
      setSelectedId(first.id);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="relative h-[560px] overflow-hidden rounded-2xl bg-[#111214] lg:h-[640px]">
        <BrainCanvas
          links={links}
          matchIds={matchIds}
          mode={mode}
          nodes={nodes}
          onHover={setHover}
          onSelect={setSelectedId}
          selectedId={selectedId}
        />
        <div className="pointer-events-none absolute top-5 left-6">
          <p className="font-semibold text-[#f7f8f8] text-sm">Knowledge map</p>
          <p className="mt-1 text-[#b4bac3] text-xs">
            {nodes.length} nodes · {links.length} connections
          </p>
          <p className="mt-1 text-[#8a8f98] text-xs">
            {mode === "globe"
              ? "Drag to turn · Click a node to see what it connects to"
              : "Drag to move · Pinch or ctrl+scroll to zoom"}
          </p>
        </div>
        <div className="absolute top-4 right-4 flex rounded-full border border-white/15 bg-black/40 p-0.5 text-xs backdrop-blur">
          {(["globe", "flat"] as const).map((m) => (
            <button
              className={cn(
                "rounded-full px-3 py-1 font-medium transition-colors",
                mode === m
                  ? "bg-[#38bdf8] text-[#070708]"
                  : "text-[#b4bac3] hover:text-white"
              )}
              key={m}
              onClick={() => setMode(m)}
              type="button"
            >
              {m === "globe" ? "Globe" : "2D"}
            </button>
          ))}
        </div>
        <div className="absolute bottom-4 left-4 flex max-w-[70%] flex-wrap gap-1.5">
          {present.map((t) => (
            <button
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-black/50 px-2 py-1 text-[#d0d6e0] text-[11px] backdrop-blur transition-opacity",
                hidden.has(t) && "opacity-40"
              )}
              key={t}
              onClick={() => toggle(t)}
              title={hidden.has(t) ? "Show" : "Hide"}
              type="button"
            >
              <span
                className="size-2 rounded-full"
                style={{ background: BRAIN_TYPE_COLOR[t] }}
              />
              {BRAIN_TYPE_LABEL[t]}
            </button>
          ))}
        </div>
        {hovered && hover && hovered.id !== selectedId && (
          <div
            className="pointer-events-none absolute z-10 min-w-40 max-w-64 rounded-xl border bg-[#1a1b1e]/95 px-3 py-2.5 shadow-2xl backdrop-blur"
            style={{
              left: hover.x + 16,
              top: hover.y - 8,
              borderColor: `${BRAIN_TYPE_COLOR[hovered.type]}55`,
            }}
          >
            <p className="font-bold text-[#f7f8f8] text-xs leading-tight">
              {hovered.label}
            </p>
            <p
              className="mt-0.5 font-semibold text-[10px]"
              style={{ color: BRAIN_TYPE_COLOR[hovered.type] }}
            >
              {BRAIN_TYPE_LABEL[hovered.type]}
            </p>
            {hovered.sub && (
              <p className="mt-1 line-clamp-2 text-[#b4bac3] text-[10px]">
                {hovered.sub}
              </p>
            )}
            <p className="mt-1 text-[#8a8f98] text-[10px]">
              {hovered.degree} connection{hovered.degree === 1 ? "" : "s"}
            </p>
          </div>
        )}
        {nodes.length === 0 && (
          <p className="absolute inset-0 grid place-items-center text-[#8a8f98] text-sm">
            Nothing to show. Add shop data or turn a type back on.
          </p>
        )}
      </div>

      <aside className="flex flex-col gap-4 rounded-2xl border p-4">
        {selected ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p
                  className="font-semibold text-xs"
                  style={{ color: BRAIN_TYPE_COLOR[selected.type] }}
                >
                  {BRAIN_TYPE_LABEL[selected.type]}
                </p>
                <p className="break-words font-semibold">{selected.label}</p>
                {selected.sub && (
                  <p className="mt-1 text-muted-foreground text-sm">
                    {selected.sub}
                  </p>
                )}
              </div>
              <Button
                aria-label="Clear selection"
                onClick={() => setSelectedId(null)}
                size="icon"
                variant="ghost"
              >
                <XIcon />
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild size="sm" variant="outline">
                <Link href={selected.href}>
                  Open <ArrowUpRightIcon />
                </Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link
                  href={`/ask?q=${encodeURIComponent(`Tell me about ${BRAIN_TYPE_LABEL[selected.type].toLowerCase()} ${selected.label}`)}`}
                >
                  <MessageSquareIcon /> Ask Takumo
                </Link>
              </Button>
            </div>
            <p className="font-medium text-muted-foreground text-xs">
              {connections.length} connection
              {connections.length === 1 ? "" : "s"}
            </p>
            <ul className="-mx-1 flex max-h-[380px] flex-col overflow-y-auto">
              {connections.map(({ node, label }) => (
                <li key={node.id}>
                  <button
                    className="flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left text-sm hover:bg-muted"
                    onClick={() => setSelectedId(node.id)}
                    type="button"
                  >
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ background: BRAIN_TYPE_COLOR[node.type] }}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {node.label}
                    </span>
                    <span className="shrink-0 text-muted-foreground text-xs">
                      {label}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <p className="font-semibold">Filters</p>
              {(hidden.size > 0 || term) && (
                <button
                  className="text-muted-foreground text-xs hover:text-foreground"
                  onClick={() => {
                    setHidden(new Set());
                    setSearch("");
                  }}
                  type="button"
                >
                  Clear filters
                </button>
              )}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                pickFirstMatch();
              }}
            >
              <Input
                aria-label="Search the brain"
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search parts, customers, facts…"
                value={search}
              />
              {matchIds && (
                <p className="mt-1.5 text-muted-foreground text-xs">
                  {matchIds.size} match{matchIds.size === 1 ? "" : "es"}
                  {matchIds.size > 0 && " · Enter to select the first"}
                </p>
              )}
            </form>
            <ul className="flex flex-col gap-0.5">
              {present.map((t) => (
                <li key={t}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-muted">
                    <input
                      checked={!hidden.has(t)}
                      className="accent-primary"
                      onChange={() => toggle(t)}
                      type="checkbox"
                    />
                    <span
                      className="size-2 rounded-full"
                      style={{ background: BRAIN_TYPE_COLOR[t] }}
                    />
                    <span className="flex-1">{BRAIN_TYPE_LABEL[t]}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {counts.get(t)}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
      </aside>
    </div>
  );
};

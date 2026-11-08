"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { XIcon } from "lucide-react";
import { useState } from "react";
import type { AccessView, Level } from "@/lib/library/access-view";
import { addAccess, removeAccess } from "../access-actions";
import { type Change, Confirm, LEVELS, type Target } from "./access-shared";

export const PeopleWithAccess = ({
  view,
  change,
}: {
  change: Change;
  view: AccessView;
}) => (
  <section className="grid gap-1">
    <h3 className="font-medium text-sm">People with access</h3>
    <ul className="divide-y">
      {view.entries.map((entry) => (
        <li
          className="flex items-start justify-between gap-3 py-2"
          key={`${entry.kind}:${entry.who}:${entry.inheritedFrom ?? ""}:${entry.grantId ?? ""}`}
        >
          <div className="min-w-0">
            <p className="font-medium text-sm">{entry.who}</p>
            <p className="text-muted-foreground text-xs">
              {entry.level}
              {entry.inheritedFrom && ` · from ${entry.inheritedFrom}`}
            </p>
            {entry.members && (
              <p className="text-muted-foreground text-xs">
                {entry.members.length
                  ? entry.members.join(", ")
                  : "Nobody is in this department yet."}
              </p>
            )}
          </div>
          {entry.grantId && (
            <Button
              aria-label={`Remove access for ${entry.who}`}
              disabled={change.pending}
              onClick={() =>
                change.run(() => removeAccess(entry.grantId as string))
              }
              size="icon"
              variant="ghost"
            >
              <XIcon />
            </Button>
          )}
        </li>
      ))}
    </ul>
  </section>
);

type Kind = "department" | "user" | "everyone";

const choicesFor = (kind: Kind, view: AccessView) =>
  kind === "department"
    ? view.departments.map((d) => ({ id: d.id, label: d.name }))
    : view.people.map((p) => ({ id: p.userId, label: p.name }));

export const GiveAccess = ({
  target,
  view,
  change,
}: {
  change: Change;
  target: Target;
  view: AccessView;
}) => {
  const [kind, setKind] = useState<Kind>("department");
  const [who, setWho] = useState("");
  const [level, setLevel] = useState<Level>("Can view");
  const [confirming, setConfirming] = useState(false);
  const isFolder = "folderId" in target;
  const options = kind === "everyone" ? [] : choicesFor(kind, view);
  const whoLabel =
    kind === "everyone"
      ? "Everyone in the shop"
      : (options.find((o) => o.id === who)?.label ?? "");
  const principal =
    kind === "everyone" ? { type: kind } : { type: kind, id: who };
  return (
    <section className="grid gap-2 rounded-lg border p-3">
      <h3 className="font-medium text-sm">Give access</h3>
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="grid gap-1">
          <Label htmlFor="access-kind">To</Label>
          <Select
            onValueChange={(v) => {
              setKind(v as Kind);
              setWho("");
            }}
            value={kind}
          >
            <SelectTrigger className="w-full" id="access-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="department">A department</SelectItem>
              <SelectItem value="user">A person</SelectItem>
              <SelectItem value="everyone">Everyone</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {kind !== "everyone" && (
          <div className="grid gap-1">
            <Label htmlFor="access-who">
              {kind === "department" ? "Department" : "Person"}
            </Label>
            <Select onValueChange={setWho} value={who}>
              <SelectTrigger className="w-full" id="access-who">
                <SelectValue placeholder="Choose…" />
              </SelectTrigger>
              <SelectContent>
                {options.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="grid gap-1">
          <Label htmlFor="access-level">They</Label>
          <Select onValueChange={(v) => setLevel(v as Level)} value={level}>
            <SelectTrigger className="w-full" id="access-level">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[
                ...LEVELS,
                ...(isFolder ? (["Can upload only"] as Level[]) : []),
              ].map((l) => (
                <SelectItem key={l} value={l}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {view.confidential && kind === "everyone" && (
        <p className="text-muted-foreground text-xs">
          In a confidential folder, everyone may only upload: they won't see
          what's here.
        </p>
      )}
      {confirming ? (
        <Confirm
          label="Give access"
          onCancel={() => setConfirming(false)}
          onConfirm={() =>
            change.run(async () => {
              const r = await addAccess(target, principal, level);
              setConfirming(false);
              return r;
            })
          }
          pending={change.pending}
        >
          <p>
            {whoLabel}: {level.toLowerCase()}{" "}
            {isFolder ? "everything in this folder" : "this document"}.
          </p>
        </Confirm>
      ) : (
        <Button
          className="justify-self-start"
          disabled={change.pending || (kind !== "everyone" && !who)}
          onClick={() => setConfirming(true)}
          size="sm"
        >
          Give access…
        </Button>
      )}
    </section>
  );
};

"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@repo/design-system/components/ui/dialog";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { Switch } from "@repo/design-system/components/ui/switch";
import { BotIcon, LockIcon, ShieldIcon, UsersIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useState, useTransition } from "react";
import type { AccessView, Level } from "@/lib/library/access-view";
import {
  addAccess,
  changeAiMode,
  changeConfidential,
  changeInheritance,
  loadAccess,
  removeAccess,
} from "../access-actions";

type Target = { folderId: string } | { sourceId: string };
type AiMode = "off" | "search" | "full";

const AI_TEXT: Record<AiMode, { help: string; label: string }> = {
  off: {
    label: "AI processing off",
    help: "Nothing from these documents is sent to outside AI services. Their text is read here and found by the library's search; Ask Takumo doesn't use them, and scans aren't read.",
  },
  search: {
    label: "Ask can search",
    help: "Read and indexed here, with nothing sent while reading. When someone who may open them asks Takumo a question, short passages found by keywords may be sent to the AI service to answer it.",
  },
  full: {
    label: "Full AI",
    help: "Read with AI services: scans recognised, summaries, links to your records, facts for review and search by meaning. Ask Takumo uses them for people who may open them.",
  },
};

const LEVELS: Level[] = [
  "Can view",
  "Can upload",
  "Can edit",
  "Can manage access",
];

interface Outcome {
  error?: string;
  ok: boolean;
}

/** Shared by the dialog's sections: run a change, then show the result. */
interface Change {
  pending: boolean;
  /** Reload who has access (after a change made through start). */
  reload: () => Promise<void>;
  /** Run a change; on success reload who has access. */
  run: (change: () => Promise<Outcome>) => void;
  setError: (error: string | null) => void;
  /** Run a change that may come back asking for confirmation. */
  start: (work: () => Promise<void>) => void;
}

/** A short line on how an item's access works, for its header. */
export const AccessBadges = ({ view }: { view: AccessView }) => (
  <div className="flex flex-wrap items-center gap-1.5">
    {view.confidential && (
      <Badge variant="secondary">
        <ShieldIcon /> Confidential
      </Badge>
    )}
    {view.restricting && !view.inherits && !view.topLevel && (
      <Badge variant="secondary">
        <LockIcon /> Restricted
      </Badge>
    )}
    {view.aiMode !== "full" && (
      <Badge variant="outline">
        <BotIcon />{" "}
        {view.aiMode === "off" ? "AI processing disabled" : "AI: search only"}
      </Badge>
    )}
  </div>
);

/** "Are you sure" in the dialog, for changes that let more people in. */
const Confirm = ({
  children,
  onConfirm,
  onCancel,
  pending,
  label,
}: {
  children: ReactNode;
  label: string;
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
}) => (
  <div className="grid gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40">
    {children}
    <div className="flex flex-wrap gap-2">
      <Button disabled={pending} onClick={onConfirm} size="sm">
        {pending && <Spinner />} {label}
      </Button>
      <Button onClick={onCancel} size="sm" variant="ghost">
        Cancel
      </Button>
    </div>
  </div>
);

const PeopleWithAccess = ({
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

const GiveAccess = ({
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

const Inheritance = ({
  target,
  view,
  change,
}: {
  change: Change;
  target: Target;
  view: AccessView;
}) => {
  const [gains, setGains] = useState<string[] | null>(null);
  const inherit = (next: boolean, confirmed = false) =>
    change.start(async () => {
      const r = await changeInheritance(target, next, confirmed);
      if (r.ok) {
        change.setError(null);
        setGains(null);
        await change.reload();
      } else if ("gains" in r) {
        setGains(r.gains);
      } else {
        change.setError(r.error);
      }
    });
  return (
    <section className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="access-inherit">
          Inherit access from the folder above
        </Label>
        <Switch
          checked={view.inherits}
          disabled={change.pending}
          id="access-inherit"
          onCheckedChange={(on) => inherit(on)}
        />
      </div>
      <p className="text-muted-foreground text-xs">
        Turning it off keeps everyone who has access now; remove them afterwards
        to restrict it.
      </p>
      {gains && (
        <Confirm
          label="Inherit access"
          onCancel={() => setGains(null)}
          onConfirm={() => inherit(true, true)}
          pending={change.pending}
        >
          <p>These would get access: {gains.join(", ")}.</p>
        </Confirm>
      )}
    </section>
  );
};

const Confidential = ({
  folderId,
  view,
  change,
}: {
  change: Change;
  folderId: string;
  view: AccessView;
}) => {
  const [asking, setAsking] = useState<boolean | null>(null);
  return (
    <section className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="access-confidential">Confidential</Label>
        <Switch
          checked={view.confidentialHere}
          disabled={change.pending}
          id="access-confidential"
          onCheckedChange={setAsking}
        />
      </div>
      <p className="text-muted-foreground text-xs">
        Admins can't open confidential folders unless they're given access, and
        everyone may only upload to them.
      </p>
      {asking !== null && (
        <Confirm
          label={asking ? "Make confidential" : "Stop being confidential"}
          onCancel={() => setAsking(null)}
          onConfirm={() =>
            change.run(async () => {
              const r = await changeConfidential(folderId, asking);
              setAsking(null);
              return r;
            })
          }
          pending={change.pending}
        >
          <p>
            {asking
              ? "Admins lose automatic access to everything in it."
              : "Admins get access to everything in it again, and grants to everyone or a role apply in full."}
          </p>
        </Confirm>
      )}
    </section>
  );
};

const AiSetting = ({
  folderId,
  own,
  inForce,
  change,
}: {
  change: Change;
  folderId: string;
  inForce: AiMode;
  own: AiMode;
}) => {
  const [asking, setAsking] = useState<{
    message: string;
    mode: AiMode;
  } | null>(null);
  const set = (mode: AiMode, confirmed = false) =>
    change.start(async () => {
      const r = await changeAiMode(folderId, mode, confirmed);
      if (r.ok) {
        change.setError(null);
        setAsking(null);
        await change.reload();
      } else if ("confirm" in r) {
        setAsking({ mode, message: r.error });
      } else {
        change.setError(r.error);
      }
    });
  return (
    <section className="grid gap-2">
      <Label htmlFor="access-ai">AI processing</Label>
      <Select onValueChange={(v) => set(v as AiMode)} value={own}>
        <SelectTrigger className="w-full sm:w-60" id="access-ai">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(AI_TEXT) as AiMode[]).map((m) => (
            <SelectItem key={m} value={m}>
              {AI_TEXT[m].label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-muted-foreground text-xs">
        {AI_TEXT[own].help}
        {inForce !== own &&
          ` A folder above is stricter, so "${AI_TEXT[inForce].label}" applies here.`}
      </p>
      {asking && (
        <Confirm
          label="Turn it on"
          onCancel={() => setAsking(null)}
          onConfirm={() => set(asking.mode, true)}
          pending={change.pending}
        >
          <p>{asking.message}</p>
        </Confirm>
      )}
    </section>
  );
};

/**
 * Who can open a folder or document, and (for people who manage it)
 * changing that: add a department or person, remove access, stop or resume
 * inheriting, the confidential flag and the AI setting (folders). Anything
 * that lets more people in is confirmed first. The server decides every
 * change again.
 */
export const AccessDialog = ({
  target,
  name,
  initial,
  trigger,
}: {
  initial: AccessView;
  name: string;
  target: Target;
  trigger?: ReactNode;
}) => {
  const router = useRouter();
  const [view, setView] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const reload = async () => {
    const next = await loadAccess(target);
    if (next) {
      setView(next);
    }
    router.refresh();
  };
  const change: Change = {
    pending,
    setError,
    reload,
    start: (work) => startTransition(work),
    run: (work) =>
      startTransition(async () => {
        const r = await work();
        if (r.ok) {
          setError(null);
          await reload();
        } else {
          setError(r.error ?? "That didn't work. Try again.");
        }
      }),
  };
  const folderId = "folderId" in target ? target.folderId : null;
  return (
    <Dialog>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="outline">
            <UsersIcon /> Access
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Who can open {name}</DialogTitle>
          <DialogDescription>
            {view.restricting
              ? "Access is checked on every page, download and question to Takumo."
              : "Everyone in the shop can open what's in the library. Restricting access isn't available yet."}
          </DialogDescription>
        </DialogHeader>
        <AccessBadges view={view} />
        <section className="grid gap-1">
          <h3 className="font-medium text-sm">You can</h3>
          <p className="text-muted-foreground text-sm">
            {view.yours.join(", ")}.
          </p>
        </section>
        {view.restricting && <PeopleWithAccess change={change} view={view} />}
        {view.canManage && (
          <GiveAccess change={change} target={target} view={view} />
        )}
        {view.canManage && !view.topLevel && (
          <Inheritance change={change} target={target} view={view} />
        )}
        {folderId && view.canManage && view.isOwner && (
          <Confidential change={change} folderId={folderId} view={view} />
        )}
        {folderId && view.canManage && view.aiOwn && (
          <AiSetting
            change={change}
            folderId={folderId}
            inForce={view.aiMode}
            own={view.aiOwn}
          />
        )}
        {!folderId && (
          <p className="text-muted-foreground text-xs">
            {AI_TEXT[view.aiMode].help}
          </p>
        )}
        {error && (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
};

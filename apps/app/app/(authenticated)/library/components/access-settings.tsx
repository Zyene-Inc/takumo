"use client";

import { Label } from "@repo/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { Switch } from "@repo/design-system/components/ui/switch";
import { useState } from "react";
import type { AccessView } from "@/lib/library/access-view";
import {
  changeAiMode,
  changeConfidential,
  changeInheritance,
} from "../access-actions";
import {
  AI_TEXT,
  type AiMode,
  type Change,
  Confirm,
  type Target,
} from "./access-shared";

export const Inheritance = ({
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

export const Confidential = ({
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

export const AiSetting = ({
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

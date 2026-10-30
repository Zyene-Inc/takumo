"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@repo/design-system/components/ui/dialog";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  ATTRIBUTES,
  type AttributeDef,
  SUBJECT_LABEL,
  SUBJECT_TYPES,
  type SubjectType,
} from "@/lib/facts/attributes";
import { addFact } from "./actions";

const unitLabel = (def: AttributeDef | undefined) => {
  if (def?.percent) {
    return " (%)";
  }
  return def?.unit ? ` (${def.unit})` : "";
};

export const AddFact = ({
  options,
}: {
  options: Record<SubjectType, { id: string; label: string }[]>;
}) => {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<SubjectType>("routing");
  const [subjectId, setSubjectId] = useState("");
  const [attribute, setAttribute] = useState("setupMin");
  const [value, setValue] = useState("");
  const [evidence, setEvidence] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const def = ATTRIBUTES[type].find((a) => a.key === attribute);

  const pickType = (t: SubjectType) => {
    setType(t);
    setSubjectId(t === "shop" ? (options.shop[0]?.id ?? "") : "");
    setAttribute(ATTRIBUTES[t][0].key);
  };

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button size="sm">
          <PlusIcon /> Add a fact
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a fact</DialogTitle>
          <DialogDescription>
            Something your shop knows that the data doesn't say. It waits for a
            supervisor's review before it changes anything.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await addFact({
                subjectType: type,
                subjectId,
                attribute,
                value,
                evidence,
              });
              if (r.ok) {
                setOpen(false);
                setValue("");
                setEvidence("");
                setError(null);
                router.push(`/knowledge/facts?f=${r.label}`);
              } else {
                setError(r.error);
              }
            });
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="fact-type">About</Label>
              <Select
                onValueChange={(v) => pickType(v as SubjectType)}
                value={type}
              >
                <SelectTrigger id="fact-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUBJECT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {SUBJECT_LABEL[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="fact-attribute">What</Label>
              <Select onValueChange={setAttribute} value={attribute}>
                <SelectTrigger id="fact-attribute">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ATTRIBUTES[type].map((a) => (
                    <SelectItem key={a.key} value={a.key}>
                      {a.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {type !== "shop" && (
            <div className="grid gap-1.5">
              <Label htmlFor="fact-subject">{SUBJECT_LABEL[type]}</Label>
              <Select onValueChange={setSubjectId} value={subjectId}>
                <SelectTrigger id="fact-subject">
                  <SelectValue
                    placeholder={`Choose a ${SUBJECT_LABEL[type].toLowerCase()}`}
                  />
                </SelectTrigger>
                <SelectContent>
                  {options[type].map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="fact-value">
              {def?.label ?? "Value"}
              {unitLabel(def)}
            </Label>
            {def?.kind === "text" ? (
              <Textarea
                id="fact-value"
                onChange={(e) => setValue(e.target.value)}
                rows={3}
                value={value}
              />
            ) : (
              <Input
                id="fact-value"
                onChange={(e) => setValue(e.target.value)}
                value={value}
              />
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="fact-evidence">How you know</Label>
            <Input
              id="fact-evidence"
              onChange={(e) => setEvidence(e.target.value)}
              placeholder="e.g. timed the last three setups"
              value={evidence}
            />
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
          <DialogFooter>
            <Button disabled={pending} type="submit">
              {pending && <Spinner />} Add for review
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

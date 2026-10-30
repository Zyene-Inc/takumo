"use client";

import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
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
import { ENTITIES, type EntityKey, type FieldDef } from "@repo/ingest";
import { useRouter } from "next/navigation";
import { type ReactNode, useState, useTransition } from "react";
import { saveRecord } from "../actions";

const NONE = "__none__";

const inputType = (field: FieldDef) => {
  switch (field.kind) {
    case "number":
    case "integer":
    case "minutes":
      return "number";
    case "date":
      return "date";
    default:
      return "text";
  }
};

const unitSuffix = (field: FieldDef) =>
  field.kind === "minutes" ? " (minutes)" : "";

interface RecordDialogProps {
  // False for roles that can only view; the trigger isn't rendered.
  readonly canEdit?: boolean;
  readonly entity: EntityKey;
  // Fields hidden from the form; their initial value is still submitted.
  readonly hidden?: readonly string[];
  readonly initial?: Readonly<Record<string, string>>;
  // Identity fields can't change on edit (the record is matched by them).
  readonly locked?: readonly string[];
  // Choices for fields that reference other records, e.g. machine names.
  readonly options?: Readonly<Record<string, readonly string[]>>;
  readonly title: string;
  readonly trigger: ReactNode;
}

export const RecordDialog = ({
  entity,
  title,
  trigger,
  initial = {},
  locked = [],
  hidden = [],
  options = {},
  canEdit = true,
}: RecordDialogProps) => {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({ ...initial });
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, startSaving] = useTransition();
  const editing = locked.length > 0;

  const set = (key: string, value: string) =>
    setValues((current) => ({ ...current, [key]: value }));

  const submit = () => {
    startSaving(async () => {
      const result = await saveRecord(
        entity,
        values,
        editing ? "update" : "create"
      );
      if (result.ok) {
        setOpen(false);
        router.refresh();
      } else {
        setErrors(result.errors);
      }
    });
  };

  if (!canEdit) {
    return null;
  }

  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setValues({ ...initial });
          setErrors([]);
        }
      }}
      open={open}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Fields marked * are required. Changes you make here are saved as
            stated by your team.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {ENTITIES[entity].fields
            .filter((field) => !hidden.includes(field.key))
            .map((field) => {
              const id = `${entity}-${field.key}`;
              const value = values[field.key] ?? "";
              const choices =
                field.kind === "enum" ? field.values : options[field.key];
              const isLocked = locked.includes(field.key);
              return (
                <div className="grid gap-1.5" key={field.key}>
                  <Label htmlFor={id}>
                    {field.label}
                    {unitSuffix(field)}
                    {field.required && (
                      <span className="text-destructive">*</span>
                    )}
                  </Label>
                  {choices && !isLocked && field.kind !== "list" ? (
                    <Select
                      onValueChange={(v) => set(field.key, v === NONE ? "" : v)}
                      value={value || NONE}
                    >
                      <SelectTrigger className="w-full" id={id}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {!field.required && (
                          <SelectItem value={NONE}>—</SelectItem>
                        )}
                        {choices.map((choice) => (
                          <SelectItem key={choice} value={choice}>
                            {choice.replace("_", " ")}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      disabled={isLocked}
                      id={id}
                      onChange={(e) => set(field.key, e.target.value)}
                      placeholder={field.hint}
                      required={field.required}
                      step={inputType(field) === "number" ? "any" : undefined}
                      type={inputType(field)}
                      value={value}
                    />
                  )}
                </div>
              );
            })}
          {errors.length > 0 && (
            <Alert variant="destructive">
              <AlertDescription>
                {errors.map((error) => (
                  <div key={error}>{error}</div>
                ))}
              </AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button disabled={saving} type="submit">
              {saving && <Spinner />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

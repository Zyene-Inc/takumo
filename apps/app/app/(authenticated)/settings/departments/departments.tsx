"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
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
import {
  PencilIcon,
  PlusIcon,
  ShieldIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { DepartmentView } from "@/lib/library/departments";
import {
  addDepartment,
  addMember,
  removeDepartment,
  removeMember,
  renameDept,
} from "./actions";

type Act = (run: () => Promise<{ ok: boolean; error?: string }>) => void;

const useAct = () => {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const act: Act = (run) =>
    start(async () => {
      const r = await run();
      if (r.ok) {
        setError(null);
        router.refresh();
      } else {
        setError(r.error ?? "That didn't work. Try again.");
      }
    });
  return { act, error, pending };
};

const DepartmentCard = ({
  department,
  people,
}: {
  department: DepartmentView;
  people: { name: string; userId: string }[];
}) => {
  const { act, error, pending } = useAct();
  const [adding, setAdding] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const nameOf = new Map(people.map((p) => [p.userId, p.name]));
  const notIn = people.filter((p) => !department.members.includes(p.userId));
  const headingId = `department-${department.id}`;
  return (
    <article
      aria-labelledby={headingId}
      className="grid gap-3 rounded-xl border p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        {renaming === null ? (
          <h2 className="font-medium" id={headingId}>
            {department.name}
          </h2>
        ) : (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              act(() => renameDept(department.id, renaming));
              setRenaming(null);
            }}
          >
            <Label className="sr-only" htmlFor={`${headingId}-name`}>
              New name
            </Label>
            <Input
              autoFocus
              className="h-8 w-56"
              id={`${headingId}-name`}
              maxLength={80}
              onChange={(e) => setRenaming(e.target.value)}
              value={renaming}
            />
            <Button disabled={pending} size="sm" type="submit">
              Save
            </Button>
            <Button
              onClick={() => setRenaming(null)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
          </form>
        )}
        {renaming === null && (
          <div className="flex gap-1">
            <Button
              aria-label={`Rename ${department.name}`}
              onClick={() => setRenaming(department.name)}
              size="icon"
              variant="ghost"
            >
              <PencilIcon />
            </Button>
            <Button
              aria-label={`Delete ${department.name}`}
              onClick={() => setDeleting(true)}
              size="icon"
              variant="ghost"
            >
              <Trash2Icon />
            </Button>
          </div>
        )}
      </div>
      {deleting && (
        <div className="grid gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p>
            Delete {department.name}? Its members lose what it gives them access
            to.
          </p>
          <div className="flex gap-2">
            <Button
              disabled={pending}
              onClick={() => act(() => removeDepartment(department.id))}
              size="sm"
              variant="destructive"
            >
              {pending && <Spinner />} Delete
            </Button>
            <Button
              onClick={() => setDeleting(false)}
              size="sm"
              variant="ghost"
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      <div className="grid gap-1">
        <h3 className="text-muted-foreground text-xs">Opens</h3>
        {department.access.length ? (
          <ul className="flex flex-wrap gap-1">
            {department.access.map((a) => (
              <li key={a.name}>
                <Badge variant={a.confidential ? "secondary" : "outline"}>
                  {a.confidential && <ShieldIcon />}
                  {a.name}
                </Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">
            Nothing yet: give it access from a folder's Access settings.
          </p>
        )}
      </div>
      <div className="grid gap-1">
        <h3 className="text-muted-foreground text-xs">
          Members ({department.members.length})
        </h3>
        {department.members.length ? (
          <ul className="flex flex-wrap gap-1.5">
            {department.members.map((userId) => (
              <li
                className="flex items-center gap-1 rounded-full border py-0.5 pr-1 pl-2.5 text-sm"
                key={userId}
              >
                {nameOf.get(userId) ?? "Former member"}
                <Button
                  aria-label={`Remove ${nameOf.get(userId) ?? "them"} from ${department.name}`}
                  className="size-6"
                  disabled={pending}
                  onClick={() => act(() => removeMember(department.id, userId))}
                  size="icon"
                  variant="ghost"
                >
                  <XIcon />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">Nobody yet.</p>
        )}
      </div>
      {notIn.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1">
            <Label htmlFor={`${headingId}-add`}>Add someone</Label>
            <Select onValueChange={setAdding} value={adding}>
              <SelectTrigger className="w-56" id={`${headingId}-add`}>
                <SelectValue placeholder="Choose a person…" />
              </SelectTrigger>
              <SelectContent>
                {notIn.map((p) => (
                  <SelectItem key={p.userId} value={p.userId}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            disabled={pending || !adding}
            onClick={() => {
              act(() => addMember(department.id, adding));
              setAdding("");
            }}
            size="sm"
          >
            <PlusIcon /> Add
          </Button>
        </div>
      )}
      {error && (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </article>
  );
};

/** Every department, with its members and what it opens; changes for managers. */
export const Departments = ({
  departments,
  people,
}: {
  departments: DepartmentView[];
  people: { name: string; userId: string }[];
}) => {
  const { act, error, pending } = useAct();
  const [name, setName] = useState("");
  return (
    <div className="grid gap-4">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          act(() => addDepartment(name));
          setName("");
        }}
      >
        <div className="grid gap-1">
          <Label htmlFor="new-department">New department</Label>
          <Input
            className="w-64"
            id="new-department"
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            placeholder="Engineering, Human Resources…"
            value={name}
          />
        </div>
        <Button disabled={pending || !name.trim()} type="submit">
          {pending ? <Spinner /> : <PlusIcon />} Create
        </Button>
        {error && (
          <p className="w-full text-destructive text-sm" role="alert">
            {error}
          </p>
        )}
      </form>
      {departments.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No departments yet. Create one, add people, then give it access from a
          folder's Access settings.
        </p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {departments.map((d) => (
            <DepartmentCard department={d} key={d.id} people={people} />
          ))}
        </div>
      )}
    </div>
  );
};

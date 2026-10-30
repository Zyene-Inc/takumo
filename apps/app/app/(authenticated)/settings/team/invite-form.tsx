"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { invite, revoke } from "./actions";
import { INVITE_ROLES, ROLE_HELP } from "./roles";

export const InviteForm = () => {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<(typeof INVITE_ROLES)[number]>("planner");
  const [message, setMessage] = useState<{
    error: boolean;
    text: string;
  } | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="flex flex-wrap items-start gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await invite({ email, role });
          if (r.ok) {
            setMessage({ error: false, text: `Invitation sent to ${email}.` });
            setEmail("");
            router.refresh();
          } else {
            setMessage({ error: true, text: r.error });
          }
        });
      }}
    >
      <Input
        aria-label="Email"
        className="w-64"
        onChange={(e) => setEmail(e.target.value)}
        placeholder="name@yourshop.com"
        required
        type="email"
        value={email}
      />
      <Select onValueChange={(v) => setRole(v as typeof role)} value={role}>
        <SelectTrigger aria-label="Role" className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {INVITE_ROLES.map((r) => (
            <SelectItem key={r} value={r}>
              {r} · {ROLE_HELP[r]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button disabled={pending} type="submit">
        {pending && <Spinner />} Invite
      </Button>
      {message && (
        <p
          className={
            message.error
              ? "w-full text-destructive text-sm"
              : "w-full text-emerald-600 text-sm"
          }
        >
          {message.text}
        </p>
      )}
    </form>
  );
};

export const RevokeButton = ({ id, email }: { email: string; id: string }) => {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      aria-label={`Cancel the invitation to ${email}`}
      disabled={pending}
      onClick={() =>
        start(async () => {
          await revoke(id);
          router.refresh();
        })
      }
      size="icon"
      variant="ghost"
    >
      {pending ? <Spinner /> : <XIcon />}
    </Button>
  );
};

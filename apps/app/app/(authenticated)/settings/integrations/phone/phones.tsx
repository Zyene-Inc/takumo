"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { useState, useTransition } from "react";
import { addPhone, confirmCode, removePhone, resendCode } from "./actions";

export interface PhoneView {
  codeSent: boolean;
  confirmed: boolean;
  id: string;
  name: string;
  phone: string;
}

const SELECT =
  "h-9 w-full rounded-md border bg-background px-2 text-sm disabled:opacity-50";

type Message = { error: boolean; text: string } | null;

const Feedback = ({ message }: { message: Message }) =>
  message ? (
    <span
      className={
        message.error
          ? "text-destructive text-sm"
          : "text-muted-foreground text-sm"
      }
    >
      {message.text}
    </span>
  ) : null;

/** One registered phone: confirm it with its code, or remove it. */
const PhoneRow = ({ phone }: { phone: PhoneView }) => {
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<Message>(null);
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, done: string) =>
    start(async () => {
      const r = await fn();
      setMessage(
        r.ok ? { error: false, text: done } : { error: true, text: r.error ?? "" }
      );
    });

  return (
    <li className="grid gap-2 rounded-lg border px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{phone.name}</span>
        <span className="text-muted-foreground">{phone.phone}</span>
        {phone.confirmed ? (
          <Badge variant="secondary">Confirmed</Badge>
        ) : (
          <Badge variant="outline">Waiting for the code</Badge>
        )}
        <Button
          className="ml-auto"
          disabled={pending}
          onClick={() => run(() => removePhone(phone.id), "Removed.")}
          size="sm"
          type="button"
          variant="ghost"
        >
          Remove
        </Button>
      </div>
      {!phone.confirmed && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="Code"
            className="w-32"
            disabled={pending}
            inputMode="numeric"
            maxLength={6}
            onChange={(e) => setCode(e.target.value)}
            placeholder="6-digit code"
            value={code}
          />
          <Button
            disabled={pending || code.trim().length !== 6}
            onClick={() =>
              run(() => confirmCode(phone.id, code), "Confirmed.")
            }
            size="sm"
            type="button"
          >
            {pending && <Spinner />} Confirm
          </Button>
          <Button
            disabled={pending}
            onClick={() => run(() => resendCode(phone.id), "New code sent.")}
            size="sm"
            type="button"
            variant="outline"
          >
            Send a new code
          </Button>
          <Feedback message={message} />
        </div>
      )}
      {phone.confirmed && <Feedback message={message} />}
    </li>
  );
};

/** The shop's registered phones, and the form to add one. */
export const Phones = ({
  phones,
  operators,
  members,
  canManage,
  configured,
}: {
  canManage: boolean;
  configured: boolean;
  members: { name: string; userId: string }[];
  operators: { id: string; name: string }[];
  phones: PhoneView[];
}) => {
  const [phone, setPhone] = useState("");
  const [who, setWho] = useState("me");
  const [name, setName] = useState("");
  const [message, setMessage] = useState<Message>(null);
  const [pending, start] = useTransition();

  return (
    <section className="grid gap-3">
      <h2 className="font-semibold text-lg">Registered phones</h2>
      {phones.length === 0 ? (
        <p className="text-muted-foreground text-sm">No phones yet.</p>
      ) : (
        <ul className="grid gap-2">
          {phones.map((p) => (
            <PhoneRow key={p.id} phone={p} />
          ))}
        </ul>
      )}
      {configured && (
        <div className="grid gap-2 rounded-lg border px-3 py-3">
          <p className="font-medium text-sm">Add a phone</p>
          <p className="text-muted-foreground text-xs">
            Takumo texts the phone a 6-digit code. Type it in here to confirm
            the phone is really theirs.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {canManage ? (
              <select
                aria-label="Whose phone"
                className={SELECT}
                disabled={pending}
                onChange={(e) => setWho(e.target.value)}
                value={who}
              >
                <option value="me">My phone</option>
                {operators.length > 0 && (
                  <optgroup label="Operators">
                    {operators.map((o) => (
                      <option key={o.id} value={`operator:${o.id}`}>
                        {o.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {members.length > 0 && (
                  <optgroup label="People on Takumo">
                    {members.map((m) => (
                      <option key={m.userId} value={`member:${m.userId}`}>
                        {m.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                <option value="name">Someone else…</option>
              </select>
            ) : (
              <p className="self-center text-muted-foreground text-sm">
                Your phone
              </p>
            )}
            {who === "name" && (
              <Input
                aria-label="Their name"
                disabled={pending}
                onChange={(e) => setName(e.target.value)}
                placeholder="Their name"
                value={name}
              />
            )}
            <Input
              aria-label="Phone number"
              disabled={pending}
              inputMode="tel"
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+1 555 123 4567"
              value={phone}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={pending || !phone.trim()}
              onClick={() =>
                start(async () => {
                  const r = await addPhone({ phone, who, name });
                  if (r.ok) {
                    setPhone("");
                    setName("");
                    setMessage({
                      error: false,
                      text: "Code sent. Type it in next to the phone above.",
                    });
                  } else {
                    setMessage({ error: true, text: r.error });
                  }
                })
              }
              size="sm"
              type="button"
            >
              {pending && <Spinner />} Send code
            </Button>
            <Feedback message={message} />
          </div>
        </div>
      )}
    </section>
  );
};

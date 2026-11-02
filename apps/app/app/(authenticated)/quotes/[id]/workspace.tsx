"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { Spinner } from "@repo/design-system/components/ui/spinner";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import {
  CheckIcon,
  CopyIcon,
  FileDownIcon,
  MailIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  SparklesIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useState, useTransition } from "react";
import { topIssues } from "@/lib/quotes/review";
import { type RfqSource, SOURCE_LABEL, STATUS_LABEL } from "@/lib/quotes/types";
import type { RfqView } from "@/lib/quotes/view";
import { localToday } from "../../schedule/gantt";
import {
  approve,
  deleteRfq,
  draftQuote,
  rereadRfq,
  setDeclined,
  updateReplyDraft,
  updateRfq,
} from "../actions";
import { STATUS_VARIANT } from "../status";
import { Confirm } from "./confirm";
import type { ViewerFile } from "./drawing-viewer";
import { LineCard, LineSpecForm } from "./line-card";
import { ReviewFocusProvider } from "./review-focus";
import { TopIssues } from "./top-issues";

export interface WorkspaceOptions {
  canEdit: boolean;
  customers: string[];
  machines: string[];
  materials: string[];
}

const EDITABLE = ["review", "drafted", "failed"];

const Section = ({
  title,
  action,
  children,
}: {
  action?: ReactNode;
  children: ReactNode;
  title: string;
}) => (
  <section className="rounded-xl border">
    <div className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
      <h2 className="font-medium text-sm">{title}</h2>
      {action}
    </div>
    <div className="p-4">{children}</div>
  </section>
);

const CopyButton = ({ text, label }: { label: string; text: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      size="sm"
      variant="ghost"
    >
      {copied ? <CheckIcon /> : <CopyIcon />} {copied ? "Copied" : label}
    </Button>
  );
};

const RfqDetails = ({ rfq, editable }: { editable: boolean; rfq: RfqView }) => {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState({
    customerName: rfq.customerName ?? "",
    contact: rfq.contact ?? "",
    requestedDate: rfq.requestedDate ?? "",
    notes: rfq.notes ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = (key: keyof typeof values, value: string) =>
    setValues((v) => ({ ...v, [key]: value }));

  if (editing) {
    return (
      <Section title="Request">
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await updateRfq(rfq.id, values);
              if (r.ok) {
                setEditing(false);
                setError(null);
                router.refresh();
              } else {
                setError(r.error);
              }
            });
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="rfq-customer">Customer</Label>
              <Input
                id="rfq-customer"
                list="rfq-customers"
                onChange={(e) => set("customerName", e.target.value)}
                value={values.customerName}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rfq-contact">Contact</Label>
              <Input
                id="rfq-contact"
                onChange={(e) => set("contact", e.target.value)}
                value={values.contact}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="rfq-needed">Needed by</Label>
              <Input
                id="rfq-needed"
                onChange={(e) => set("requestedDate", e.target.value)}
                type="date"
                value={values.requestedDate}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="rfq-notes">Requirements</Label>
            <Textarea
              id="rfq-notes"
              onChange={(e) => set("notes", e.target.value)}
              rows={3}
              value={values.notes}
            />
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
          <div className="flex gap-2">
            <Button disabled={pending} size="sm" type="submit">
              {pending && <Spinner />} Save
            </Button>
            <Button
              onClick={() => setEditing(false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
          </div>
        </form>
      </Section>
    );
  }

  const facts: [string, ReactNode][] = [
    [
      "Customer",
      rfq.customerName ? (
        <span key="customer">
          {rfq.customerName}{" "}
          {!rfq.customerKnown && (
            <Badge className="ml-1" variant="outline">
              New customer
            </Badge>
          )}
        </span>
      ) : (
        <span className="text-destructive" key="customer">
          Not found: add it
        </span>
      ),
    ],
    ["Contact", rfq.contact ?? "—"],
    ["Needed by", rfq.requestedDate ?? "Not stated"],
    ["Payment terms", rfq.paymentTermDays ? `Net ${rfq.paymentTermDays}` : "—"],
  ];
  return (
    <Section
      action={
        editable && (
          <Button onClick={() => setEditing(true)} size="sm" variant="ghost">
            <PencilIcon /> Edit
          </Button>
        )
      }
      title="Request"
    >
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {facts.map(([label, value]) => (
          <div className="flex gap-2" key={label}>
            <dt className="w-28 shrink-0 text-muted-foreground">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {rfq.notes && (
        <p className="mt-3 whitespace-pre-line text-sm">
          <span className="text-muted-foreground">Requirements: </span>
          {rfq.notes}
        </p>
      )}
    </Section>
  );
};

type Run = (
  label: string,
  action: () => Promise<
    { ok: boolean; error?: string } & Record<string, unknown>
  >,
  done?: (r: Record<string, unknown>) => string | null
) => void;

const draftLabel = (drafting: boolean, undrafted: number, total: number) => {
  if (drafting) {
    return "Drafting…";
  }
  if (undrafted === total) {
    return "Draft quote";
  }
  return `Draft ${undrafted} line${undrafted === 1 ? "" : "s"}`;
};

const MoreMenu = ({
  rfq,
  editable,
  draftable,
  pending,
  run,
  onDraftAll,
  onDeleted,
}: {
  draftable: boolean;
  editable: boolean;
  onDeleted: (error: string | null) => void;
  onDraftAll: () => void;
  pending: boolean;
  rfq: RfqView;
  run: Run;
}) => {
  const [confirming, setConfirming] = useState<"reread" | "delete" | null>(
    null
  );
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label="More actions"
            disabled={pending}
            size="icon"
            variant="ghost"
          >
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {draftable && rfq.status === "drafted" && (
            <DropdownMenuItem onSelect={onDraftAll}>
              Re-draft every line
            </DropdownMenuItem>
          )}
          {editable && (
            <DropdownMenuItem onSelect={() => setConfirming("reread")}>
              Read the RFQ again
            </DropdownMenuItem>
          )}
          {editable && (
            <DropdownMenuItem
              onSelect={() => run("decline", () => setDeclined(rfq.id, true))}
            >
              Decline (no quote)
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            className="text-destructive"
            onSelect={() => setConfirming("delete")}
          >
            Delete RFQ
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Confirm
        action="Read again"
        description="Its lines, drafts and your edits are replaced by a fresh reading."
        onConfirm={() => run("reread", () => rereadRfq(rfq.id))}
        onOpenChange={(open) => setConfirming(open ? "reread" : null)}
        open={confirming === "reread"}
        title="Read the RFQ again?"
      />
      <Confirm
        action="Delete"
        description="The RFQ and its drafts are deleted. This can't be undone."
        onConfirm={async () =>
          onDeleted(
            (await deleteRfq(rfq.id)).ok
              ? null
              : "Quoted RFQs are kept with their quotes."
          )
        }
        onOpenChange={(open) => setConfirming(open ? "delete" : null)}
        open={confirming === "delete"}
        title={`Delete ${rfq.label}?`}
      />
    </>
  );
};

const ActionBar = ({
  rfq,
  canEdit,
  pending,
  busy,
  run,
  onDeleted,
}: {
  busy: string | null;
  canEdit: boolean;
  onDeleted: (error: string | null) => void;
  pending: boolean;
  rfq: RfqView;
  run: Run;
}) => {
  const editable = canEdit && EDITABLE.includes(rfq.status);
  const draftable = canEdit && ["review", "drafted"].includes(rfq.status);
  const undrafted = rfq.lines.filter((l) => !l.draft).length;
  const quoted = rfq.lines.some((l) => l.quote);
  const draft = (redo: boolean) =>
    run(
      redo ? "redraft" : "draft",
      () => draftQuote(rfq.id, localToday(), redo),
      (r) => {
        const errors = (r.errors as string[] | undefined) ?? [];
        return errors.length ? errors.join(" ") : null;
      }
    );

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h1 className="font-semibold text-xl">{rfq.label}</h1>
          <Badge variant={STATUS_VARIANT[rfq.status]}>
            {STATUS_LABEL[rfq.status]}
          </Badge>
        </div>
        <p className="truncate text-muted-foreground text-sm">
          {[rfq.subject, rfq.sender, rfq.fileName]
            .filter(Boolean)
            .join(" · ") || "Pasted RFQ"}{" "}
          · received {rfq.receivedAt.slice(0, 10)}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {draftable && undrafted > 0 && (
          <Button
            disabled={pending}
            onClick={() => draft(false)}
            size="sm"
            variant={rfq.status === "review" ? "default" : "outline"}
          >
            {busy === "draft" ? <Spinner /> : <SparklesIcon />}
            {draftLabel(busy === "draft", undrafted, rfq.lines.length)}
          </Button>
        )}
        {draftable && rfq.status === "drafted" && (
          <Button
            disabled={pending || rfq.problems.length > 0}
            onClick={() =>
              run(
                "approve",
                () => approve(rfq.id),
                (r) =>
                  `Quoted as ${(r.quoteNos as string[]).join(", ")}. Send the reply draft from your mailbox, or download the PDF and send it with the email beside it.`
              )
            }
            size="sm"
          >
            {busy === "approve" ? <Spinner /> : <CheckIcon />} Approve quote
          </Button>
        )}
        {(quoted || rfq.reply) && (
          <Button asChild size="sm" variant="outline">
            <a href={`/quotes/${rfq.id}/pdf`} rel="noopener" target="_blank">
              <FileDownIcon /> Quote PDF
            </a>
          </Button>
        )}
        {canEdit && rfq.status === "declined" && (
          <Button
            disabled={pending}
            onClick={() => run("reopen", () => setDeclined(rfq.id, false))}
            size="sm"
            variant="outline"
          >
            Reopen
          </Button>
        )}
        {canEdit &&
          (editable || ["declined", "reading"].includes(rfq.status)) && (
            <MoreMenu
              draftable={draftable}
              editable={editable}
              onDeleted={onDeleted}
              onDraftAll={() => draft(true)}
              pending={pending}
              rfq={rfq}
              run={run}
            />
          )}
      </div>
    </div>
  );
};

const StatusAlerts = ({
  rfq,
  busy,
  message,
  canEdit,
}: {
  busy: string | null;
  canEdit: boolean;
  message: { error: boolean; text: string } | null;
  rfq: RfqView;
}) => (
  <>
    {(busy === "draft" || busy === "redraft") && (
      <Alert>
        <Spinner />
        <AlertTitle>Drafting the quote</AlertTitle>
        <AlertDescription>
          Finding comparable jobs, building the cost and fitting each quantity
          into the schedule. New parts take longer: Takumo estimates their
          operations first.
        </AlertDescription>
      </Alert>
    )}
    {message && (
      <Alert variant={message.error ? "destructive" : "default"}>
        <AlertDescription>{message.text}</AlertDescription>
      </Alert>
    )}
    {rfq.error && rfq.status === "failed" && (
      <Alert variant="destructive">
        <AlertTitle>Takumo couldn't read this RFQ</AlertTitle>
        <AlertDescription>{rfq.error}</AlertDescription>
      </Alert>
    )}
    {rfq.status === "drafted" && rfq.problems.length > 0 && canEdit && (
      <Alert>
        <AlertTitle>Before you approve</AlertTitle>
        <AlertDescription>
          <ul className="list-disc pl-4">
            {rfq.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </AlertDescription>
      </Alert>
    )}
  </>
);

const MAILBOX: Record<string, string> = {
  gmail: "Gmail",
  outlook: "Outlook",
};

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

type Reply = NonNullable<RfqView["reply"]>;

const recipient = (reply: Reply) => {
  if (reply.inThread) {
    return ", in the customer's thread";
  }
  return reply.to ? `, to ${reply.to}` : "";
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const DraftStatus = ({ reply }: { reply: Reply | null }) => {
  if (!reply) {
    return (
      <p className="text-muted-foreground text-sm">
        Every line has a price. Put the reply in your mailbox as a draft, with
        the quote PDF attached.
      </p>
    );
  }
  if (reply.sent) {
    return (
      <p className="text-sm">
        Sent {when(reply.sent.at)}
        {reply.mailbox ? ` from ${reply.mailbox}` : ""}.{" "}
        {reply.sent.prices.length > 0 &&
          `${plural(reply.sent.prices.length, "price")} read from it.`}
      </p>
    );
  }
  if (reply.pdfOnly) {
    return (
      <p className="text-sm">
        The quote PDF is ready. Download it and send it with your reply.
      </p>
    );
  }
  return (
    <p className="text-sm">
      In your {MAILBOX[reply.provider] ?? "mailbox"} drafts{recipient(reply)},
      with the quote PDF attached. Updated {when(reply.updatedAt)}. Check it and
      send it from there; Takumo never sends it.
    </p>
  );
};

/** Where the reply draft is, and the button to make or refresh it (F2.5). */
const MailboxDraft = ({
  rfq,
  canEdit,
  pending,
  busy,
  run,
}: {
  busy: string | null;
  canEdit: boolean;
  pending: boolean;
  rfq: RfqView;
  run: Run;
}) => {
  const reply = rfq.reply;
  const priced =
    rfq.lines.length > 0 && rfq.lines.every((l) => l.quote || l.sendFinal);
  const open = ["review", "drafted", "quoted"].includes(rfq.status);
  if (!(reply || (priced && open))) {
    return null;
  }
  return (
    <Section title="Reply draft">
      <div className="grid gap-3">
        <DraftStatus reply={reply} />
        {reply?.note && (
          <p className="text-muted-foreground text-sm">{reply.note}</p>
        )}
        <div className="flex flex-wrap gap-2">
          {canEdit && open && !reply?.sent && priced && (
            <Button
              disabled={pending}
              onClick={() =>
                run(
                  "reply",
                  () => updateReplyDraft(rfq.id),
                  (r) => (r.message as string | undefined) ?? null
                )
              }
              size="sm"
              variant={reply ? "outline" : "default"}
            >
              {busy === "reply" ? <Spinner /> : <MailIcon />}
              {reply ? "Update draft" : "Create draft"}
            </Button>
          )}
          {reply && (
            <Button asChild size="sm" variant="ghost">
              <a href={`/quotes/${rfq.id}/pdf`} rel="noopener" target="_blank">
                <FileDownIcon /> Download the quote PDF
              </a>
            </Button>
          )}
        </div>
      </div>
    </Section>
  );
};

/** "Original email", "Original form submission", … (every channel). */
const originalTitle = (source: string) => {
  const label = SOURCE_LABEL[source as RfqSource];
  if (source === "email") {
    return "Original email";
  }
  if (source === "phone") {
    return "Call notes";
  }
  return label ? `Original RFQ (${label.toLowerCase()})` : "Original RFQ";
};

const SidePanel = ({
  rfq,
  reply,
}: {
  reply: { body: string; subject: string } | null;
  rfq: RfqView;
}) => (
  <aside className="grid content-start gap-4">
    {reply && (
      <Section
        action={
          <CopyButton
            label="Copy"
            text={`Subject: ${reply.subject}\n\n${reply.body}`}
          />
        }
        title="Reply to the customer"
      >
        <p className="mb-2 font-medium text-sm">{reply.subject}</p>
        <pre className="whitespace-pre-wrap font-sans text-muted-foreground text-sm">
          {reply.body}
        </pre>
      </Section>
    )}
    <Section title={originalTitle(rfq.source)}>
      <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap font-sans text-sm">
        {rfq.body}
      </pre>
    </Section>
  </aside>
);

export const Workspace = ({
  rfq,
  reply,
  files = [],
  ...options
}: WorkspaceOptions & {
  /** The RFQ's files, to show each line's drawing beside its price. */
  files?: ViewerFile[];
  reply: { body: string; subject: string } | null;
  rfq: RfqView;
}) => {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    error: boolean;
    text: string;
  } | null>(null);
  const [adding, setAdding] = useState(false);
  const editable = options.canEdit && EDITABLE.includes(rfq.status);
  const fileById = new Map(files.map((f) => [f.id, f]));
  const lineLabel = (l: RfqView["lines"][number]) =>
    `Line ${l.lineNo} · ${l.partNo ?? l.description ?? "Part"}`;
  const issues = topIssues(
    rfq.lines.map((l) => ({
      id: l.id,
      label: lineLabel(l),
      drawing: l.drawing,
    })),
    rfq.questions
  );

  const run: Run = (label, action, done) =>
    start(async () => {
      setBusy(label);
      setMessage(null);
      const result = await action();
      setBusy(null);
      if (result.ok) {
        const text = done?.(result) ?? null;
        setMessage(text ? { error: false, text } : null);
      } else {
        setMessage({
          error: true,
          text: result.error ?? "Something went wrong.",
        });
      }
      router.refresh();
    });

  return (
    <ReviewFocusProvider>
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <ActionBar
          busy={busy}
          canEdit={options.canEdit}
          onDeleted={(error) => {
            if (error) {
              setMessage({ error: true, text: error });
            } else {
              router.push("/quotes");
            }
          }}
          pending={pending}
          rfq={rfq}
          run={run}
        />
        <StatusAlerts
          busy={busy}
          canEdit={options.canEdit}
          message={message}
          rfq={rfq}
        />
        <TopIssues flags={issues.flags} questions={issues.questions} />
        <MailboxDraft
          busy={busy}
          canEdit={options.canEdit}
          pending={pending}
          rfq={rfq}
          run={run}
        />

        <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_24rem]">
          <div className="grid min-w-0 content-start gap-4">
            <RfqDetails
              editable={editable}
              key={`${rfq.customerName}-${rfq.contact}-${rfq.requestedDate}`}
              rfq={rfq}
            />
            {rfq.lines.map((line) => (
              <LineCard
                drawingFile={
                  line.drawing
                    ? (fileById.get(line.drawing.fileId) ?? null)
                    : null
                }
                editable={editable}
                key={line.id}
                line={line}
                options={options}
                otherLines={rfq.lines
                  .filter((l) => l.id !== line.id && !l.quote)
                  .map((l) => ({ id: l.id, label: lineLabel(l) }))}
                requestedDate={rfq.requestedDate}
                rfqId={rfq.id}
                status={rfq.status}
              />
            ))}
            {editable && adding && (
              <Section title={`Line ${rfq.lines.length + 1}`}>
                <LineSpecForm
                  materials={options.materials}
                  onDone={() => setAdding(false)}
                  rfqId={rfq.id}
                />
              </Section>
            )}
            {editable && !adding && (
              <Button
                className="justify-self-start"
                onClick={() => setAdding(true)}
                size="sm"
                variant="outline"
              >
                <PlusIcon /> Add a line
              </Button>
            )}
          </div>
          <SidePanel reply={reply} rfq={rfq} />
        </div>
        <datalist id="rfq-customers">
          {options.customers.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </div>
    </ReviewFocusProvider>
  );
};

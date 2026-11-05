"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { topIssues } from "@/lib/quotes/review";
import { type RfqSource, SOURCE_LABEL } from "@/lib/quotes/types";
import type { RfqView } from "@/lib/quotes/view";
import { ActionBar, EDITABLE, type Run, StatusAlerts } from "./action-bar";
import type { ViewerFile } from "./drawing-viewer";
import { LineCard, LineSpecForm } from "./line-card";
import { MailboxDraft } from "./mailbox-draft";
import { ReviewFocusProvider } from "./review-focus";
import { CopyButton, RfqDetails, Section } from "./rfq-details";
import { TopIssues } from "./top-issues";

export interface WorkspaceOptions {
  canEdit: boolean;
  customers: string[];
  machines: string[];
  materials: string[];
}

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

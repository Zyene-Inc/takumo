"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { cn } from "@repo/design-system/lib/utils";
import { PencilIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { RfqStatus } from "@/lib/quotes/types";
import type { LineView } from "@/lib/quotes/view";
import { deleteLine } from "../actions";
import { Confirm } from "./confirm";
import { Comparables, CostBuild } from "./cost-build";
import { DrawingSummary, type OtherLine } from "./drawing-summary";
import { DrawingViewer, type ViewerFile } from "./drawing-viewer";
import { InputsEditor } from "./inputs-editor";
import { MatchBadge, Notices } from "./line-card-parts";
import { LineSpecForm } from "./line-spec-form";
import { Outcome } from "./outcome";
import { PriceTable } from "./price-table";
import { lineAnchor } from "./review-focus";
import type { WorkspaceOptions } from "./workspace";

export { LineSpecForm } from "./line-spec-form";

export const LineCard = ({
  line,
  rfqId,
  status,
  editable,
  options,
  otherLines = [],
  requestedDate,
  drawingFile = null,
}: {
  /** The drawing this line was read from, shown beside its price (F2.6). */
  drawingFile?: ViewerFile | null;
  editable: boolean;
  line: LineView;
  options: WorkspaceOptions;
  /** The RFQ's other lines, to merge one into this one. */
  otherLines?: OtherLine[];
  requestedDate: string | null;
  rfqId: string;
  status: RfqStatus;
}) => {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [pending, start] = useTransition();
  const draftable = options.canEdit && ["review", "drafted"].includes(status);
  const title = `${line.partNo ?? line.description ?? "Part"}${line.rev ? ` rev ${line.rev}` : ""}`;
  const spec: [string, string | null][] = [
    [
      "Qty",
      line.qtys.length
        ? line.qtys.map((q) => q.toLocaleString()).join(" / ")
        : null,
    ],
    ["Material", line.materialText ?? line.material?.name ?? null],
    ["Finish", line.finish],
    ["Tolerances", line.tolerances],
    ["Notes", line.notes],
  ];

  return (
    <section className="scroll-mt-4 rounded-xl border" id={lineAnchor(line.id)}>
      <Confirm
        action="Remove"
        description="Its draft goes too."
        onConfirm={() =>
          start(async () => {
            await deleteLine(rfqId, line.id);
            router.refresh();
          })
        }
        onOpenChange={setRemoving}
        open={removing}
        title={`Remove line ${line.lineNo}?`}
      />
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <h2 className="font-medium">
          <span className="text-muted-foreground">Line {line.lineNo} · </span>
          {title}
        </h2>
        <MatchBadge line={line} />
        {line.material &&
          line.materialText &&
          line.material.name !== line.materialText && (
            <Badge variant="secondary">Material: {line.material.name}</Badge>
          )}
        {editable && !editing && (
          <div className="ml-auto flex gap-1">
            <Button onClick={() => setEditing(true)} size="sm" variant="ghost">
              <PencilIcon /> Edit
            </Button>
            <Button
              aria-label={`Remove line ${line.lineNo}`}
              disabled={pending}
              onClick={() => setRemoving(true)}
              size="icon"
              variant="ghost"
            >
              <Trash2Icon />
            </Button>
          </div>
        )}
      </div>
      <div
        className={cn(
          "grid gap-4 p-4",
          drawingFile &&
            "lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start"
        )}
      >
        {drawingFile && (
          <div className="lg:sticky lg:top-4">
            <DrawingViewer file={drawingFile} lineId={line.id} rfqId={rfqId} />
          </div>
        )}
        <div className="grid min-w-0 gap-4">
          {editing ? (
            <LineSpecForm
              line={line}
              materials={options.materials}
              onDone={() => setEditing(false)}
              rfqId={rfqId}
            />
          ) : (
            <>
              {line.description && (
                <p className="text-sm">{line.description}</p>
              )}
              <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                {spec
                  .filter(([, v]) => v)
                  .map(([label, value]) => (
                    <div className="flex gap-1.5" key={label}>
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
              </dl>
            </>
          )}
          {line.drawing && !editing && (
            <DrawingSummary
              drawing={line.drawing}
              editable={editable && !line.quote}
              lineId={line.id}
              otherLines={otherLines}
              rfqId={rfqId}
            />
          )}
          {line.quote ? (
            <Outcome canEdit={options.canEdit} line={line} rfqId={rfqId} />
          ) : null}
          {line.draft ? (
            <>
              <PriceTable
                editable={draftable && !line.quote}
                key={`${line.draft.estimatedAt}-${JSON.stringify(line.final)}`}
                line={line}
                requestedDate={requestedDate}
                rfqId={rfqId}
              />
              <Notices line={line} />
              <Comparables line={line} />
              <CostBuild key={line.draft.estimatedAt} line={line} />
              <InputsEditor
                editable={draftable && !line.quote}
                key={`inputs-${line.draft.estimatedAt}`}
                line={line}
                machines={options.machines}
                rfqId={rfqId}
              />
            </>
          ) : (
            !editing && (
              <p className="text-muted-foreground text-sm">
                {line.part
                  ? "Not drafted yet."
                  : "Not drafted yet. Takumo will propose operations for this new part from the most similar parts you make."}
              </p>
            )
          )}
        </div>
      </div>
    </section>
  );
};

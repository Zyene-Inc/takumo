"use client";

import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import { PlusIcon, Trash2Icon } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { nextKey, type OpRow } from "./inputs-editor";
import { SOURCE_LABEL } from "./line-card-parts";

export const OperationRows = ({
  editable,
  machines,
  ops,
  editOp,
  setOps,
  setOpsChanged,
}: {
  editable: boolean;
  editOp: (key: number, patch: Partial<OpRow>) => void;
  machines: string[];
  ops: OpRow[];
  setOps: Dispatch<SetStateAction<OpRow[]>>;
  setOpsChanged: (changed: boolean) => void;
}) => (
  <>
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">Op</TableHead>
            <TableHead>Machine</TableHead>
            <TableHead className="text-right">Setup min</TableHead>
            <TableHead className="text-right">Run min/ea</TableHead>
            <TableHead>From</TableHead>
            {editable && <TableHead className="w-10" />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {ops.map((op) => (
            <TableRow key={op.key}>
              <TableCell>
                {editable ? (
                  <Input
                    aria-label="Operation number"
                    className="h-8 w-16"
                    onChange={(e) => editOp(op.key, { seq: e.target.value })}
                    type="number"
                    value={op.seq}
                  />
                ) : (
                  op.seq
                )}
              </TableCell>
              <TableCell>
                {editable ? (
                  <Select
                    onValueChange={(v) => editOp(op.key, { workCenter: v })}
                    value={op.workCenter}
                  >
                    <SelectTrigger aria-label="Machine" className="h-8 w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {machines.map((m) => (
                        <SelectItem key={m} value={m}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  op.workCenter
                )}
              </TableCell>
              <TableCell className="text-right">
                {editable ? (
                  <Input
                    aria-label="Setup minutes"
                    className="ml-auto h-8 w-20 text-right"
                    min={0}
                    onChange={(e) => editOp(op.key, { setup: e.target.value })}
                    step="any"
                    type="number"
                    value={op.setup}
                  />
                ) : (
                  op.setup
                )}
              </TableCell>
              <TableCell className="text-right">
                {editable ? (
                  <Input
                    aria-label="Run minutes per part"
                    className="ml-auto h-8 w-20 text-right"
                    min={0}
                    onChange={(e) => editOp(op.key, { run: e.target.value })}
                    step="any"
                    type="number"
                    value={op.run}
                  />
                ) : (
                  op.run
                )}
              </TableCell>
              <TableCell className="max-w-72">
                <Badge
                  variant={op.source === "comparable" ? "outline" : "secondary"}
                >
                  {SOURCE_LABEL[op.source]}
                </Badge>
                {op.note && (
                  <p className="mt-1 text-muted-foreground text-xs">
                    {op.note}
                  </p>
                )}
              </TableCell>
              {editable && (
                <TableCell>
                  <Button
                    aria-label="Remove operation"
                    onClick={() => {
                      setOpsChanged(true);
                      setOps((rows) => rows.filter((r) => r.key !== op.key));
                    }}
                    size="icon"
                    variant="ghost"
                  >
                    <Trash2Icon />
                  </Button>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
    {editable && (
      <Button
        className="justify-self-start"
        onClick={() => {
          setOpsChanged(true);
          const last = Math.max(0, ...ops.map((o) => Number(o.seq) || 0));
          setOps((rows) => [
            ...rows,
            {
              key: nextKey(),
              seq: String(last + 10),
              workCenter: machines[0] ?? "",
              setup: "0",
              run: "0",
              source: "estimator",
              note: null,
              alt: [],
            },
          ]);
        }}
        size="sm"
        variant="outline"
      >
        <PlusIcon /> Add operation
      </Button>
    )}
  </>
);

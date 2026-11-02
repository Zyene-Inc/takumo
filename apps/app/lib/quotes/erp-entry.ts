// A won quote written out for whoever enters orders in the ERP. Pure, so the
// browser can use it too.
import type { ErpOrderEntry } from "./types";

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Plain lines, one field each, ready to copy. */
export const erpEntryText = (e: ErpOrderEntry) =>
  [
    `Customer: ${e.customer ?? "(not set)"}`,
    `Part: ${e.partNo}${e.rev ? ` rev ${e.rev}` : ""}`,
    ...(e.description ? [`Description: ${e.description}`] : []),
    `Quantity: ${e.qty.toLocaleString("en-US")}`,
    `Unit price: ${money(e.unitPrice)}`,
    `Total: ${money(e.unitPrice * e.qty)}`,
    `Due date: ${e.dueDate}`,
    `Quote: ${e.quoteNo}`,
  ].join("\n");

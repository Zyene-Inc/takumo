// Which POs the ERP now has: once someone enters a PO, the ERP's orders report
// brings the order back, and the PO is marked entered. Pure.

import { normalizePartNo } from "../quotes/match";

export interface WaitingPo {
  customerId: string | null;
  id: string;
  lines: { partId: string | null; partNo: string | null; qty: number | null }[];
  poNo: string | null;
  receivedAt: Date;
}

export interface ErpOrderRow {
  createdAt: Date;
  customerId: string | null;
  customerPo: string | null;
  partId: string;
  partNo: string;
  qty: number;
}

const PO_PREFIX = /^p\.?\s*o\.?\s*(#|no\.?|number)?\s*/;
const NOT_ALNUM = /[^a-z0-9]/g;

/** "PO# 4500-12 " → "450012" */
export const poKey = (value: string | null) =>
  (value ?? "").toLowerCase().replace(PO_PREFIX, "").replace(NOT_ALNUM, "");

/**
 * The POs an ERP order answers: the same customer PO number, or the same
 * customer, part and quantity on an order that appeared after the PO came in.
 */
export const enteredPos = (pos: WaitingPo[], orders: ErpOrderRow[]) => {
  const byPo = new Map<string, ErpOrderRow[]>();
  for (const o of orders) {
    const key = poKey(o.customerPo);
    if (key) {
      byPo.set(key, [...(byPo.get(key) ?? []), o]);
    }
  }
  return pos
    .filter((po) => {
      const key = poKey(po.poNo);
      const sameNumber = key ? byPo.get(key) : undefined;
      if (
        sameNumber?.some(
          (o) =>
            !(po.customerId && o.customerId) || o.customerId === po.customerId
        )
      ) {
        return true;
      }
      if (!po.customerId) {
        return false;
      }
      return po.lines.some(
        (line) =>
          line.qty !== null &&
          orders.some(
            (o) =>
              o.customerId === po.customerId &&
              o.qty === line.qty &&
              o.createdAt.getTime() >= po.receivedAt.getTime() &&
              (line.partId
                ? o.partId === line.partId
                : !!line.partNo &&
                  normalizePartNo(o.partNo) === normalizePartNo(line.partNo))
          )
      );
    })
    .map((po) => po.id);
};

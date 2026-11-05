// When each order's material is ready (docs/PRODUCT-PLAN.md F3.2): from stock
// on hand, else the open purchase-order line that covers the shortfall, else
// today plus the material's lead time ("not ordered yet"). Orders take
// material in due-date order, so two orders never count the same bar, and a
// new order (the capacity check's) comes after the orders already promised.
// The date is the order's release date for the scheduler; the note says
// where the material comes from in words. Pure, so tested.

import { normalizeUnit } from "../quotes/pricing";

export interface MaterialPart {
  materialId: string | null;
  /** How much stock one part uses, in `unit`. */
  qtyPerUnit: number | null;
  /** The unit of qtyPerUnit (Part.materialUnit), else the material's. */
  unit: string | null;
}

interface MaterialInfo {
  leadTimeDays: number | null;
  name: string;
  unit: string;
}

export interface StockRow {
  materialId: string;
  qtyAllocated: number;
  qtyOnHand: number;
  unit: string | null;
}

export interface PoRow {
  dueDate: Date;
  materialId: string | null;
  poNo: string;
  qtyOrdered: number;
  qtyReceived: number;
  status: string;
  unit: string | null;
}

export interface MaterialOrder {
  dueDate: Date;
  orderNo: string;
  partId: string;
  qty: number;
  /** In progress: its material is already on the floor. */
  started: boolean;
}

export interface MaterialReady {
  /** YYYY-MM-DD when later than today; null when ready today or unknown. */
  date: string | null;
  /** Where the material comes from, for people ("12 ft of 6061 on hand"). */
  note: string;
  /** Not on hand, not on order: someone has to buy it. */
  notOrdered: boolean;
  /** Takumo couldn't tell (no material or usage on the part). */
  unknown: boolean;
}

const DAY_MS = 86_400_000;
const OPEN_PO = new Set(["open", "partial"]);

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Tue Nov 10: how a planner reads a date (as the engine writes it). */
export const shortDay = (day: string) =>
  new Date(`${day}T00:00:00Z`)
    .toLocaleDateString("en-US", {
      timeZone: "UTC",
      weekday: "short",
      month: "short",
      day: "numeric",
    })
    .replace(",", "");

const amount = (qty: number, unit: string) =>
  `${Number(qty.toFixed(qty < 10 ? 2 : 1))} ${unit}`;

/** Same unit, however it's spelled; a missing unit is the material's. */
const sameUnit = (a: string | null, b: string) =>
  a === null || normalizeUnit(a) === normalizeUnit(b) || a.trim() === b.trim();

interface Pool {
  /** Stock the ERP set aside (for orders it knows): existing orders first. */
  allocated: number;
  /** Stock nobody has claimed. */
  free: number;
  /** Open PO lines, soonest first, with what's still to come on each. */
  incoming: { due: string; left: number; poNo: string }[];
}

const pools = (
  materials: Map<string, MaterialInfo>,
  stock: StockRow[],
  pos: PoRow[]
) => {
  const byMaterial = new Map<string, Pool>();
  const pool = (id: string) => {
    let p = byMaterial.get(id);
    if (!p) {
      p = { allocated: 0, free: 0, incoming: [] };
      byMaterial.set(id, p);
    }
    return p;
  };
  for (const s of stock) {
    const m = materials.get(s.materialId);
    if (!(m && sameUnit(s.unit, m.unit))) {
      continue;
    }
    const allocated = Math.max(0, Math.min(s.qtyAllocated, s.qtyOnHand));
    const p = pool(s.materialId);
    p.allocated += allocated;
    p.free += Math.max(0, s.qtyOnHand - allocated);
  }
  for (const line of pos) {
    const m = line.materialId ? materials.get(line.materialId) : null;
    if (!(m && line.materialId && OPEN_PO.has(line.status))) {
      continue;
    }
    const left = Math.max(0, line.qtyOrdered - line.qtyReceived);
    if (left > 0 && sameUnit(line.unit, m.unit)) {
      pool(line.materialId).incoming.push({
        due: iso(line.dueDate),
        left,
        poNo: line.poNo,
      });
    }
  }
  for (const p of byMaterial.values()) {
    p.incoming.sort((a, b) => a.due.localeCompare(b.due));
  }
  return byMaterial;
};

const unknown = (note: string): MaterialReady => ({
  date: null,
  note,
  notOrdered: false,
  unknown: true,
});

/** Take `need` from the PO lines in date order; the day the last bit lands. */
const fromIncoming = (p: Pool, need: number) => {
  let short = need;
  const used: string[] = [];
  let due: string | null = null;
  for (const line of p.incoming) {
    if (short <= 1e-9) {
      break;
    }
    const take = Math.min(line.left, short);
    if (take <= 0) {
      continue;
    }
    line.left -= take;
    short -= take;
    due = line.due;
    used.push(line.poNo);
  }
  return { due, short, used: [...new Set(used)] };
};

const readyOne = (
  order: MaterialOrder,
  part: MaterialPart | undefined,
  materials: Map<string, MaterialInfo>,
  byMaterial: Map<string, Pool>,
  today: string,
  isNew: boolean
): MaterialReady => {
  const m = part?.materialId ? materials.get(part.materialId) : undefined;
  if (!(part?.materialId && m)) {
    return unknown("Material not set on the part, so it isn't checked.");
  }
  if (!(part.qtyPerUnit && part.qtyPerUnit > 0)) {
    return unknown(
      `How much ${m.name} one part uses isn't known, so material isn't checked.`
    );
  }
  if (part.unit && !sameUnit(part.unit, m.unit)) {
    return unknown(
      `The part uses ${m.name} in ${part.unit} but it's stocked in ${m.unit}, so material isn't checked.`
    );
  }
  const need = order.qty * part.qtyPerUnit;
  const p = byMaterial.get(part.materialId) ?? {
    allocated: 0,
    free: 0,
    incoming: [],
  };
  // Existing orders use what the ERP set aside first; a new order can't.
  const fromAllocated = isNew ? 0 : Math.min(p.allocated, need);
  p.allocated -= fromAllocated;
  const fromFree = Math.min(p.free, need - fromAllocated);
  p.free -= fromFree;
  const short = need - fromAllocated - fromFree;
  const needed = `${amount(need, m.unit)} of ${m.name}`;
  if (short <= 1e-9) {
    return {
      date: null,
      note: `${needed} on hand`,
      notOrdered: false,
      unknown: false,
    };
  }
  const coming = fromIncoming(p, short);
  if (coming.short <= 1e-9 && coming.due) {
    const late = coming.due < today;
    return {
      date: coming.due > today ? coming.due : null,
      note: late
        ? `${needed}: the rest was due ${shortDay(coming.due)} on ${coming.used.join(", ")} (overdue)`
        : `${needed}: the rest arrives ${shortDay(coming.due)} on ${coming.used.join(", ")}`,
      notOrdered: false,
      unknown: false,
    };
  }
  const missing = amount(coming.short, m.unit);
  if (m.leadTimeDays === null) {
    return {
      date: null,
      note: `${needed}: ${missing} short and not on order, and ${m.name} has no lead time set`,
      notOrdered: true,
      unknown: false,
    };
  }
  const arrives = iso(
    new Date(Date.parse(`${today}T00:00:00Z`) + m.leadTimeDays * DAY_MS)
  );
  return {
    date: arrives,
    note: `${needed}: ${missing} short and not ordered yet; with its ${m.leadTimeDays}-day lead time, ${shortDay(arrives)} at the earliest`,
    notOrdered: true,
    unknown: false,
  };
};

/**
 * Material-ready per order. `orders` are the open orders; `extra` (the
 * capacity check's new order) takes what's left after them.
 */
export const materialReady = (input: {
  extra?: MaterialOrder | null;
  materials: Map<string, MaterialInfo>;
  orders: MaterialOrder[];
  parts: Map<string, MaterialPart>;
  pos: PoRow[];
  stock: StockRow[];
  today: string;
}): Map<string, MaterialReady> => {
  const byMaterial = pools(input.materials, input.stock, input.pos);
  const result = new Map<string, MaterialReady>();
  const waiting = input.orders
    .filter((o) => !o.started)
    .sort(
      (a, b) =>
        a.dueDate.getTime() - b.dueDate.getTime() ||
        a.orderNo.localeCompare(b.orderNo)
    );
  for (const order of waiting) {
    result.set(
      order.orderNo,
      readyOne(
        order,
        input.parts.get(order.partId),
        input.materials,
        byMaterial,
        input.today,
        false
      )
    );
  }
  if (input.extra) {
    result.set(
      input.extra.orderNo,
      readyOne(
        input.extra,
        input.parts.get(input.extra.partId),
        input.materials,
        byMaterial,
        input.today,
        true
      )
    );
  }
  return result;
};

// The operator roster: people, shifts and the machines they run.

import "server-only";
import { parseClock, parseDays, WEEKDAYS } from "../shifts";
import type { ParsedRecord, Value } from "../transform";
import {
  type Context,
  type Counter,
  count,
  defined,
  list,
  listNote,
  num,
  str,
  synced,
  yesNo,
} from "./common";

/** The shift a row describes, or undefined when it has no shift columns. */
export const shiftOf = (v: Record<string, Value>) => {
  const start = str(v.shiftStart);
  const end = str(v.shiftEnd);
  if (!(start && end)) {
    return undefined;
  }
  const from = parseClock(start);
  const to = parseClock(end);
  if (!(from && to)) {
    return undefined;
  }
  const days = str(v.shiftDays);
  return { start: from, end: to, days: (days && parseDays(days)) || WEEKDAYS };
};

/**
 * Who a roster row is: by the ERP's employee id, else by name, but by name
 * only among people with no employee id yet (typed in, or from a report
 * without ids), so two people who share a name stay two.
 */
export class OperatorMatcher {
  private readonly byExternal = new Map<string, string>();
  private readonly byName = new Map<string, string>();

  constructor(rows: { externalId: string | null; id: string; name: string }[]) {
    for (const r of rows) {
      if (r.externalId) {
        this.byExternal.set(r.externalId, r.id);
      } else {
        this.byName.set(r.name.toLowerCase(), r.id);
      }
    }
  }

  find(name: string, externalId: string | null) {
    const named = this.byName.get(name.toLowerCase());
    return externalId ? (this.byExternal.get(externalId) ?? named) : named;
  }

  /** Saved: known by id from now on (their name no longer matches others). */
  add(id: string, name: string, externalId: string | null) {
    if (externalId) {
      this.byExternal.set(externalId, id);
      this.byName.delete(name.toLowerCase());
    } else {
      this.byName.set(name.toLowerCase(), id);
    }
  }
}

/** A roster row's machines, shift and flags, as Operator fields. */
export const operatorFields = (
  v: Record<string, Value>,
  machines: Map<string, string>,
  unknownMachines: Set<string>
) => {
  const skills =
    v.skills === undefined ? undefined : list(v.skills).map(String);
  const workCenterIds = skills?.flatMap((m) => {
    const id = machines.get(m.toLowerCase());
    if (!id) {
      unknownMachines.add(m);
    }
    return id ? [id] : [];
  });
  const shift = shiftOf(v);
  const active = yesNo(v.active);
  const unattended = yesNo(v.unattended);
  return {
    ...(skills === undefined ? {} : { skills, workCenterIds }),
    ...(shift === undefined ? {} : { shifts: shift }),
    ...(active === undefined ? {} : { active }),
    ...(unattended === undefined ? {} : { canRunUnattended: unattended }),
  };
};

// Matched by the ERP's employee id when the report has one (two people can
// share a name), else by name.
export const saveOperators = async (
  ctx: Context,
  records: ParsedRecord[],
  c: Counter
) => {
  const { db, orgId } = ctx;
  const existing = await db.operator.findMany({
    where: { orgId },
    select: { id: true, name: true, externalId: true },
  });
  const machines = new Map(
    (
      await db.workCenter.findMany({
        where: { orgId },
        select: { id: true, name: true },
      })
    ).map((w) => [w.name.toLowerCase(), w.id])
  );
  const unknownMachines = new Set<string>();
  const people = new OperatorMatcher(existing);
  for (const { values: v } of records) {
    const name = str(v.name) as string;
    const externalId = str(v.employeeId);
    const data = {
      name,
      ...defined({ hourlyRate: num(v.hourlyRate), externalId }),
      ...operatorFields(v, machines, unknownMachines),
      ...synced(ctx),
    };
    const id = people.find(name, externalId);
    const saved = id
      ? await db.operator.update({ where: { id }, data })
      : await db.operator.create({ data: { orgId, ...data } });
    people.add(saved.id, name, externalId);
    count(c, Boolean(id));
  }
  const note = listNote(
    "Machines on the roster that aren't in your machine list (add them, or check the spelling)",
    unknownMachines
  );
  if (note) {
    ctx.notes.push(note);
  }
};

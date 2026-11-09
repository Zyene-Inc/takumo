// The shop brain: every record Takumo knows about, and how they connect.
// Pure so it can be tested without a database; the Brain page loads the rows.

export const BRAIN_TYPES = [
  "customer",
  "part",
  "material",
  "work_center",
  "order",
  "quote",
  "rfq",
  "fact",
  "document",
  "shop",
] as const;
export type BrainType = (typeof BRAIN_TYPES)[number];

export const BRAIN_TYPE_LABEL: Record<BrainType, string> = {
  customer: "Customer",
  part: "Part",
  material: "Material",
  work_center: "Machine",
  order: "Order",
  quote: "Quote",
  rfq: "RFQ",
  fact: "Fact",
  document: "Document",
  shop: "Shop",
};

// Warmbly's category tones at their 400 shade, for the dark knowledge map.
export const BRAIN_TYPE_COLOR: Record<BrainType, string> = {
  customer: "#38bdf8", // sky
  part: "#a78bfa", // violet
  material: "#e879f9", // fuchsia
  work_center: "#fb923c", // orange
  order: "#34d399", // emerald
  quote: "#fbbf24", // amber
  rfq: "#f87171", // red
  fact: "#a3e635", // lime
  document: "#94a3b8", // slate
  shop: "#f7f8f8", // Warmbly's dark-theme text
};

export interface BrainNode {
  degree: number;
  /** Where the record lives in the app. */
  href: string;
  id: string;
  label: string;
  /** One short line under the label, e.g. a description or status. */
  sub?: string;
  type: BrainType;
}

export interface BrainLink {
  label: string;
  source: string;
  target: string;
}

export interface Brain {
  links: BrainLink[];
  nodes: BrainNode[];
}

export interface BrainRows {
  bom: { childPartId: string; parentPartId: string }[];
  customers: { id: string; name: string }[];
  documents: {
    id: string;
    /** Records the document was linked to when it was read ("part:<id>"). */
    links?: string[];
    name: string;
    summary: string | null;
  }[];
  facts: {
    attribute: string;
    id: string;
    number: number;
    subjectId: string;
    subjectLabel: string;
    subjectType: string;
    value: unknown;
  }[];
  materials: { id: string; name: string; spec: string | null }[];
  orders: {
    customerId: string | null;
    id: string;
    orderNo: string;
    partId: string;
    status: string;
  }[];
  parts: {
    customerId: string | null;
    description: string | null;
    id: string;
    materialId: string | null;
    partNo: string;
    rev: string;
  }[];
  quotes: {
    customerId: string | null;
    id: string;
    partId: string | null;
    quoteNo: string;
    rfqId: string | null;
    status: string;
  }[];
  rfqs: {
    customerId: string | null;
    customerName: string | null;
    id: string;
    number: number;
    subject: string | null;
  }[];
  routings: { id: string; partId: string; seq: number; workCenterId: string }[];
  shopName: string;
  workCenters: { id: string; name: string; type: string | null }[];
}

const q = (s: string) => encodeURIComponent(s);
const short = (s: string, n = 80) =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

const factText = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value);

/** Names short enough to match by accident ("A", "HA") don't link documents. */
const MIN_MENTION = 4;

class Graph {
  readonly nodes = new Map<string, BrainNode>();
  readonly links: BrainLink[] = [];
  private readonly seen = new Set<string>();

  add(node: Omit<BrainNode, "degree">) {
    this.nodes.set(node.id, { ...node, degree: 0 });
  }

  /** Links two records once; a missing record (deleted, or not loaded) is skipped. */
  link(source: string, target: string | null, label: string) {
    if (
      !target ||
      source === target ||
      !this.nodes.has(source) ||
      !this.nodes.has(target)
    ) {
      return;
    }
    const key = source < target ? `${source}|${target}` : `${target}|${source}`;
    if (this.seen.has(key)) {
      return;
    }
    this.seen.add(key);
    this.links.push({ source, target, label });
  }
}

/** A node id, or null when the record has no such link. */
const ref = (type: BrainType, id: string | null | undefined) =>
  id ? `${type}:${id}` : null;

const addShopRecords = (g: Graph, rows: BrainRows) => {
  for (const c of rows.customers) {
    g.add({
      id: `customer:${c.id}`,
      type: "customer",
      label: c.name,
      href: `/shop/customers?q=${q(c.name)}`,
    });
  }
  for (const m of rows.materials) {
    g.add({
      id: `material:${m.id}`,
      type: "material",
      label: m.name,
      sub: m.spec ?? undefined,
      href: `/shop/materials?q=${q(m.name)}`,
    });
  }
  for (const w of rows.workCenters) {
    g.add({
      id: `work_center:${w.id}`,
      type: "work_center",
      label: w.name,
      sub: w.type?.replaceAll("_", " "),
      href: `/shop/work-centers?q=${q(w.name)}`,
    });
  }
  for (const p of rows.parts) {
    g.add({
      id: `part:${p.id}`,
      type: "part",
      label: p.rev && p.rev !== "A" ? `${p.partNo} rev ${p.rev}` : p.partNo,
      sub: p.description ? short(p.description) : undefined,
      href: `/shop/parts/${p.id}`,
    });
  }
};

const addActivity = (g: Graph, rows: BrainRows) => {
  for (const r of rows.rfqs) {
    g.add({
      id: `rfq:${r.id}`,
      type: "rfq",
      label: `RFQ-${String(r.number).padStart(4, "0")}`,
      sub: r.subject ? short(r.subject) : (r.customerName ?? undefined),
      href: `/quotes/${r.id}`,
    });
  }
  for (const o of rows.quotes) {
    g.add({
      id: `quote:${o.id}`,
      type: "quote",
      label: o.quoteNo,
      sub: o.status,
      href: o.rfqId
        ? `/quotes/${o.rfqId}`
        : `/quotes/history?q=${q(o.quoteNo)}`,
    });
  }
  for (const o of rows.orders) {
    g.add({
      id: `order:${o.id}`,
      type: "order",
      label: o.orderNo,
      sub: o.status.replaceAll("_", " "),
      href: `/shop/orders?q=${q(o.orderNo)}`,
    });
  }
  for (const d of rows.documents) {
    g.add({
      id: `document:${d.id}`,
      type: "document",
      label: d.name,
      sub: d.summary ? short(d.summary) : undefined,
      href: `/knowledge#source-${d.id}`,
    });
  }
};

const linkRecords = (g: Graph, rows: BrainRows) => {
  for (const p of rows.parts) {
    g.link(`part:${p.id}`, ref("customer", p.customerId), "made for");
    g.link(`part:${p.id}`, ref("material", p.materialId), "made from");
  }
  for (const r of rows.routings) {
    g.link(
      `part:${r.partId}`,
      `work_center:${r.workCenterId}`,
      `op ${r.seq} on`
    );
  }
  for (const b of rows.bom) {
    g.link(`part:${b.parentPartId}`, `part:${b.childPartId}`, "contains");
  }
  for (const o of rows.orders) {
    g.link(`order:${o.id}`, `part:${o.partId}`, "for part");
    g.link(`order:${o.id}`, ref("customer", o.customerId), "ordered by");
  }
  for (const o of rows.quotes) {
    g.link(`quote:${o.id}`, ref("part", o.partId), "quotes part");
    g.link(`quote:${o.id}`, ref("customer", o.customerId), "quoted to");
    g.link(`quote:${o.id}`, ref("rfq", o.rfqId), "answers");
  }
  for (const r of rows.rfqs) {
    g.link(`rfq:${r.id}`, ref("customer", r.customerId), "sent by");
  }
};

// Facts hang off what they describe. An operation's fact describes its part.
const addFacts = (g: Graph, rows: BrainRows) => {
  const routingPart = new Map(rows.routings.map((r) => [r.id, r.partId]));
  const subjectOf = (f: BrainRows["facts"][number]) => {
    if (f.subjectType === "shop") {
      return "shop";
    }
    if (f.subjectType === "routing") {
      return ref("part", routingPart.get(f.subjectId));
    }
    return `${f.subjectType}:${f.subjectId}`;
  };
  if (rows.facts.some((f) => f.subjectType === "shop")) {
    g.add({
      id: "shop",
      type: "shop",
      label: rows.shopName,
      sub: "Shop-wide knowledge",
      href: "/knowledge/facts",
    });
  }
  for (const f of rows.facts) {
    const id = `fact:${f.id}`;
    const text =
      f.attribute === "note"
        ? factText(f.value)
        : `${f.subjectLabel}: ${f.attribute} = ${factText(f.value)}`;
    g.add({
      id,
      type: "fact",
      label: `F-${f.number}`,
      sub: short(text),
      href: `/knowledge/facts?f=F-${f.number}`,
    });
    g.link(id, subjectOf(f), "about");
  }
};

const MENTIONABLE = new Set<BrainType>([
  "part",
  "customer",
  "material",
  "work_center",
]);

// Documents call machines "machine:"; the Brain calls them work centers.
const MACHINE_REF = /^machine:/;

// A document mentions the parts, customers, materials and machines it names.
const linkDocuments = (g: Graph, rows: BrainRows) => {
  const named = [...g.nodes.values()]
    .filter((n) => MENTIONABLE.has(n.type) && n.label.length >= MIN_MENTION)
    .map((n) => ({
      id: n.id,
      name: (n.type === "part"
        ? n.label.split(" rev ")[0]
        : n.label
      ).toLowerCase(),
    }));
  for (const d of rows.documents) {
    // Read with evidence when it was uploaded: use those links.
    if (d.links?.length) {
      for (const ref of d.links) {
        const id = ref.replace(MACHINE_REF, "work_center:");
        if (g.nodes.has(id)) {
          g.link(`document:${d.id}`, id, "mentions");
        }
      }
      continue;
    }
    const text = `${d.name} ${d.summary ?? ""}`.toLowerCase();
    for (const n of named) {
      if (text.includes(n.name)) {
        g.link(`document:${d.id}`, n.id, "mentions");
      }
    }
  }
};

export const buildBrain = (rows: BrainRows): Brain => {
  const g = new Graph();
  addShopRecords(g, rows);
  addActivity(g, rows);
  linkRecords(g, rows);
  addFacts(g, rows);
  linkDocuments(g, rows);
  for (const l of g.links) {
    const a = g.nodes.get(l.source);
    const b = g.nodes.get(l.target);
    if (a && b) {
      a.degree++;
      b.degree++;
    }
  }
  return { nodes: [...g.nodes.values()], links: g.links };
};

// What a shop can upload, and the fields Takumo needs from each kind of sheet.
// Synonyms drive the offline column matcher; the AI matcher sees labels and hints.

export type FieldKind =
  | "text"
  | "number"
  | "integer"
  | "date"
  | "minutes"
  | "list"
  | "enum";

export interface FieldDef {
  readonly hint?: string;
  readonly key: string;
  readonly kind: FieldKind;
  readonly label: string;
  readonly required?: boolean;
  readonly synonyms: readonly string[];
  readonly valueAliases?: Readonly<Record<string, string>>;
  // For kind "enum": allowed values and common spellings that map to them.
  readonly values?: readonly string[];
}

export const ENTITY_KEYS = [
  "workCenters",
  "customers",
  "materials",
  "parts",
  "routings",
  "orders",
  "quotes",
  "jobs",
] as const;

export type EntityKey = (typeof ENTITY_KEYS)[number];

export interface EntityDef {
  readonly description: string;
  // Header of the downloadable template, in field order.
  readonly fields: readonly FieldDef[];
  // Rows are matched to existing records by these fields on re-import.
  readonly identity: readonly string[];
  readonly key: EntityKey;
  readonly label: string;
}

const workCenters: EntityDef = {
  key: "workCenters",
  label: "Machines / work centers",
  description: "Every machine or station a job can run on.",
  identity: ["name"],
  fields: [
    {
      key: "name",
      label: "Name",
      kind: "text",
      required: true,
      synonyms: [
        "name",
        "machine",
        "machine name",
        "work center",
        "workcenter",
        "wc",
        "resource",
        "equipment",
        "asset",
        "station",
        "cell",
      ],
    },
    {
      key: "type",
      label: "Type",
      kind: "text",
      synonyms: ["type", "machine type", "category", "class", "process"],
      hint: "e.g. cnc_mill, lathe, press_brake",
    },
    {
      key: "hourlyRate",
      label: "Hourly rate",
      kind: "number",
      synonyms: [
        "hourly rate",
        "rate",
        "cost per hour",
        "burden rate",
        "shop rate",
        "$/hr",
        "rate/hr",
      ],
      hint: "Shop rate in dollars per hour",
    },
    {
      key: "efficiency",
      label: "Efficiency",
      kind: "number",
      synonyms: ["efficiency", "oee", "utilization", "eff"],
      hint: "0.0–1.0 or a percentage",
    },
    {
      key: "hoursPerDay",
      label: "Hours per day",
      kind: "number",
      synonyms: [
        "hours per day",
        "hours/day",
        "hrs/day",
        "available hours",
        "capacity hours",
        "daily hours",
      ],
    },
  ],
};

const customers: EntityDef = {
  key: "customers",
  label: "Customers",
  description: "Who you make parts for.",
  identity: ["name"],
  fields: [
    {
      key: "name",
      label: "Name",
      kind: "text",
      required: true,
      synonyms: ["name", "customer", "customer name", "client", "account"],
    },
    {
      key: "paymentTermDays",
      label: "Payment terms (days)",
      kind: "integer",
      synonyms: ["payment terms", "terms", "net days", "payment term days"],
      hint: "Net 30 → 30",
    },
  ],
};

const materials: EntityDef = {
  key: "materials",
  label: "Materials",
  description: "Raw stock and purchased material.",
  identity: ["name"],
  fields: [
    {
      key: "name",
      label: "Name",
      kind: "text",
      required: true,
      synonyms: ["name", "material", "material name", "stock", "item"],
    },
    {
      key: "spec",
      label: "Spec",
      kind: "text",
      synonyms: ["spec", "specification", "standard", "grade"],
    },
    {
      key: "unitCost",
      label: "Unit cost",
      kind: "number",
      synonyms: ["unit cost", "cost", "price", "cost per unit"],
    },
    {
      key: "unit",
      label: "Unit",
      kind: "text",
      synonyms: ["unit", "uom", "unit of measure"],
      hint: "ea, ft, lb, sheet…",
    },
    {
      key: "leadTimeDays",
      label: "Lead time (days)",
      kind: "integer",
      synonyms: ["lead time", "lead time days", "lt", "lead days"],
    },
  ],
};

const parts: EntityDef = {
  key: "parts",
  label: "Parts",
  description: "Part numbers you make, with revision, customer and material.",
  identity: ["partNo", "rev"],
  fields: [
    {
      key: "partNo",
      label: "Part number",
      kind: "text",
      required: true,
      synonyms: [
        "part no",
        "part number",
        "part",
        "part #",
        "pn",
        "p/n",
        "item",
        "item number",
        "sku",
      ],
    },
    {
      key: "rev",
      label: "Revision",
      kind: "text",
      synonyms: ["rev", "revision", "rev level"],
      hint: "Defaults to A",
    },
    {
      key: "description",
      label: "Description",
      kind: "text",
      synonyms: ["description", "desc", "part description", "name", "title"],
    },
    {
      key: "customer",
      label: "Customer",
      kind: "text",
      synonyms: ["customer", "customer name", "client"],
    },
    {
      key: "material",
      label: "Material",
      kind: "text",
      synonyms: ["material", "raw material", "stock", "alloy"],
    },
  ],
};

const routings: EntityDef = {
  key: "routings",
  label: "Routings",
  description:
    "The operations each part goes through, with setup and run times.",
  identity: ["partNo", "seq"],
  fields: [
    {
      key: "partNo",
      label: "Part number",
      kind: "text",
      required: true,
      synonyms: ["part no", "part number", "part", "pn", "p/n", "item"],
    },
    {
      key: "rev",
      label: "Revision",
      kind: "text",
      synonyms: ["rev", "revision", "part rev"],
      hint: "Leave blank to use the part's latest revision",
    },
    {
      key: "seq",
      label: "Operation number",
      kind: "integer",
      required: true,
      synonyms: [
        "seq",
        "op",
        "operation",
        "op no",
        "op #",
        "operation number",
        "step",
        "sequence",
      ],
      hint: "10, 20, 30…",
    },
    {
      key: "workCenter",
      label: "Machine / work center",
      kind: "text",
      required: true,
      synonyms: ["work center", "workcenter", "wc", "machine", "resource"],
    },
    {
      key: "setupMin",
      label: "Setup time",
      kind: "minutes",
      required: true,
      synonyms: [
        "setup",
        "setup min",
        "setup time",
        "setup minutes",
        "setup hrs",
      ],
    },
    {
      key: "runMinPerUnit",
      label: "Run time per part",
      kind: "minutes",
      required: true,
      synonyms: [
        "run",
        "run min",
        "run time",
        "cycle time",
        "run min per unit",
        "run per piece",
        "cycle",
      ],
    },
    {
      key: "altWorkCenters",
      label: "Alternate machines",
      kind: "list",
      synonyms: [
        "alt work centers",
        "alt work center",
        "alternates",
        "alternate",
        "alternate machines",
        "alternate machine",
        "alt machine",
        "alt machines",
        "alt wc",
      ],
      hint: "Separated by | , or ;",
    },
  ],
};

const orders: EntityDef = {
  key: "orders",
  label: "Open orders",
  description: "Sales orders or jobs in the shop: what's due and when.",
  identity: ["orderNo"],
  fields: [
    {
      key: "orderNo",
      label: "Order number",
      kind: "text",
      required: true,
      synonyms: [
        "order no",
        "order number",
        "order",
        "so",
        "so number",
        "sales order",
        "job",
        "job number",
        "wo",
        "work order",
      ],
    },
    {
      key: "partNo",
      label: "Part number",
      kind: "text",
      required: true,
      synonyms: ["part no", "part number", "part", "pn", "p/n", "item"],
    },
    {
      key: "qty",
      label: "Quantity",
      kind: "integer",
      required: true,
      synonyms: ["qty", "quantity", "order qty", "qty ordered", "pcs"],
    },
    {
      key: "dueDate",
      label: "Due date",
      kind: "date",
      required: true,
      synonyms: ["due date", "due", "ship date", "promise date", "need date"],
    },
    {
      key: "customer",
      label: "Customer",
      kind: "text",
      synonyms: ["customer", "customer name", "client"],
    },
    {
      key: "price",
      label: "Order value",
      kind: "number",
      synonyms: [
        "price",
        "total",
        "amount",
        "value",
        "order value",
        "ext price",
      ],
    },
    {
      key: "priority",
      label: "Priority",
      kind: "integer",
      synonyms: ["priority", "prio", "rank"],
    },
    {
      key: "status",
      label: "Status",
      kind: "enum",
      synonyms: ["status", "state"],
      values: ["open", "in_progress", "done", "cancelled"],
      valueAliases: {
        new: "open",
        released: "open",
        firm: "open",
        hold: "open",
        "on hold": "open",
        wip: "in_progress",
        "in progress": "in_progress",
        started: "in_progress",
        running: "in_progress",
        complete: "done",
        completed: "done",
        closed: "done",
        shipped: "done",
        canceled: "cancelled",
        void: "cancelled",
      },
    },
  ],
};

const quotes: EntityDef = {
  key: "quotes",
  label: "Past quotes",
  description: "Quotes you sent, won or lost: the basis for pricing new work.",
  identity: ["quoteNo"],
  fields: [
    {
      key: "quoteNo",
      label: "Quote number",
      kind: "text",
      required: true,
      synonyms: ["quote no", "quote number", "quote", "quote #", "estimate"],
    },
    {
      key: "qty",
      label: "Quantity",
      kind: "integer",
      required: true,
      synonyms: ["qty", "quantity", "pcs"],
    },
    {
      key: "customer",
      label: "Customer",
      kind: "text",
      synonyms: ["customer", "customer name", "client"],
    },
    {
      key: "partNo",
      label: "Part number",
      kind: "text",
      synonyms: ["part no", "part number", "part", "pn", "p/n", "item"],
    },
    {
      key: "price",
      label: "Quoted price",
      kind: "number",
      synonyms: ["price", "quoted price", "total", "amount", "quote total"],
    },
    {
      key: "leadTimeDays",
      label: "Lead time (days)",
      kind: "integer",
      synonyms: ["lead time", "lead time days", "lt", "lead days"],
    },
    {
      key: "estCost",
      label: "Estimated cost",
      kind: "number",
      synonyms: ["est cost", "estimated cost", "estimate cost", "cost"],
    },
    {
      key: "actualCost",
      label: "Actual cost",
      kind: "number",
      synonyms: ["actual cost", "actual", "job cost"],
    },
    {
      key: "status",
      label: "Status",
      kind: "enum",
      synonyms: ["status", "result", "outcome", "won/lost"],
      values: ["open", "won", "lost"],
      valueAliases: {
        pending: "open",
        sent: "open",
        awarded: "won",
        win: "won",
        po: "won",
        "po received": "won",
        loss: "lost",
        declined: "lost",
        "no bid": "lost",
      },
    },
    {
      key: "quotedAt",
      label: "Quote date",
      kind: "date",
      synonyms: ["quoted at", "quote date", "date", "sent", "created"],
    },
  ],
};

const jobs: EntityDef = {
  key: "jobs",
  label: "Job history",
  description:
    "Operations already run: actual setup and run times, from the ERP or traveler logs. Takumo compares them with your routings to correct setup and run times.",
  identity: ["orderNo", "seq"],
  fields: [
    {
      key: "orderNo",
      label: "Order number",
      kind: "text",
      required: true,
      synonyms: [
        "order no",
        "order number",
        "order",
        "so",
        "job",
        "job number",
        "wo",
        "work order",
      ],
    },
    {
      key: "partNo",
      label: "Part number",
      kind: "text",
      required: true,
      synonyms: ["part no", "part number", "part", "pn", "p/n", "item"],
    },
    {
      key: "seq",
      label: "Operation number",
      kind: "integer",
      required: true,
      synonyms: ["seq", "op", "operation", "op no", "op number", "step"],
    },
    {
      key: "workCenter",
      label: "Machine / work center",
      kind: "text",
      synonyms: ["work center", "machine", "workcenter", "resource", "wc"],
    },
    {
      key: "setupMin",
      label: "Actual setup time",
      kind: "minutes",
      required: true,
      synonyms: [
        "setup",
        "setup time",
        "actual setup",
        "setup min",
        "setup hrs",
      ],
    },
    {
      key: "runMin",
      label: "Actual run time (whole lot)",
      kind: "minutes",
      required: true,
      hint: "Total run time for all the parts, not per part",
      synonyms: [
        "run",
        "run time",
        "actual run",
        "run min",
        "run hrs",
        "cycle total",
      ],
    },
    {
      key: "qtyGood",
      label: "Good parts",
      kind: "integer",
      required: true,
      synonyms: [
        "qty good",
        "good",
        "good qty",
        "qty",
        "quantity",
        "completed",
      ],
    },
    {
      key: "qtyScrap",
      label: "Scrapped parts",
      kind: "integer",
      synonyms: ["scrap", "qty scrap", "scrap qty", "rejected", "rejects"],
    },
    {
      key: "finishedAt",
      label: "Finished on",
      kind: "date",
      required: true,
      synonyms: [
        "finished",
        "finished on",
        "finish date",
        "end date",
        "completed on",
        "date",
        "end",
      ],
    },
    {
      key: "plannedSetupMin",
      label: "Planned setup time",
      kind: "minutes",
      hint: "What the routing said at the time; defaults to today's routing",
      synonyms: [
        "planned setup",
        "standard setup",
        "est setup",
        "estimated setup",
      ],
    },
  ],
};

export const ENTITIES: Readonly<Record<EntityKey, EntityDef>> = {
  workCenters,
  customers,
  materials,
  parts,
  routings,
  orders,
  quotes,
  jobs,
};

// A CSV header row users can download and fill in.
export const templateCsv = (entity: EntityKey) =>
  `${ENTITIES[entity].fields.map((f) => f.label).join(",")}\n`;

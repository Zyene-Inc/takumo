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
  // For numbers: zero or less is a row error (quantities).
  readonly positive?: boolean;
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
  "stock",
  "purchaseOrders",
  "operators",
  "operations",
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

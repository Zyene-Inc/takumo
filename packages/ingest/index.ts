// Shop data import: CSV/XLSX rows → column mapping → typed records → database.
// Parsing and matching are pure and run anywhere; saving and AI mapping are
// server-only (import them from "@repo/ingest/save" and "@repo/ingest/ai-mapping").

export * from "./entities";
export * from "./match";
export * from "./transform";

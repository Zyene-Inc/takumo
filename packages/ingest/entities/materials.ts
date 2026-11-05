import type { EntityDef } from "./types";

export const materials: EntityDef = {
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
      key: "erpId",
      label: "ERP id",
      kind: "text",
      synonyms: [
        "erp id",
        "material id",
        "material code",
        "material no",
        "item id",
        "item code",
        "stock code",
      ],
      hint: "The ERP's own code for it: a rename there then updates the same record",
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

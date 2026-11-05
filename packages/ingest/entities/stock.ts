import type { EntityDef } from "./types";

export const stock: EntityDef = {
  key: "stock",
  label: "Stock on hand",
  description: "How much of each material is in stock, by location.",
  identity: ["material", "location"],
  fields: [
    {
      key: "material",
      label: "Material",
      kind: "text",
      required: true,
      synonyms: [
        "material",
        "item",
        "part",
        "stock item",
        "raw material",
        "description",
      ],
    },
    {
      key: "location",
      label: "Location",
      kind: "text",
      synonyms: ["location", "warehouse", "bin", "site", "loc"],
    },
    {
      key: "qtyOnHand",
      label: "On hand",
      kind: "number",
      required: true,
      synonyms: [
        "on hand",
        "qty on hand",
        "quantity on hand",
        "onhand",
        "available",
        "qty",
        "quantity",
        "in stock",
      ],
    },
    {
      key: "qtyAllocated",
      label: "Allocated",
      kind: "number",
      synonyms: ["allocated", "committed", "reserved", "qty allocated"],
    },
    {
      key: "unit",
      label: "Unit",
      kind: "text",
      synonyms: ["unit", "uom", "unit of measure"],
    },
  ],
};

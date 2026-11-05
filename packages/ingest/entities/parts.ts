import type { EntityDef } from "./types";

export const parts: EntityDef = {
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
    {
      key: "materialQtyPerUnit",
      label: "Material per part",
      kind: "number",
      synonyms: [
        "qty per",
        "quantity per",
        "qty per assembly",
        "usage",
        "material per part",
        "bom qty",
      ],
      hint: "How much stock one part uses, in the material's unit (e.g. 0.42 ft)",
    },
    {
      key: "materialUnit",
      label: "Material unit",
      kind: "text",
      synonyms: ["uom", "unit", "material unit", "bom uom"],
    },
  ],
};

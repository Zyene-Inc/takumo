import type { EntityDef } from "./types";

export const customers: EntityDef = {
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
      key: "erpId",
      label: "ERP id",
      kind: "text",
      synonyms: [
        "erp id",
        "customer id",
        "cust id",
        "customer no",
        "customer number",
        "customer code",
        "cust no",
        "cust code",
        "account no",
        "account number",
        "account id",
      ],
      hint: "The ERP's own code for it: a rename there then updates the same record",
    },
    {
      key: "paymentTermDays",
      label: "Payment terms (days)",
      kind: "integer",
      synonyms: ["payment terms", "terms", "net days", "payment term days"],
      hint: "Net 30 → 30",
    },
    {
      key: "emails",
      label: "Contact emails",
      kind: "text",
      synonyms: [
        "email",
        "emails",
        "e-mail",
        "contact email",
        "buyer email",
        "email address",
        "contact",
      ],
      hint: "Used to recognise their RFQs; several are fine",
    },
    {
      key: "website",
      label: "Website or domain",
      kind: "text",
      synonyms: ["website", "web site", "web", "url", "domain", "homepage"],
    },
  ],
};

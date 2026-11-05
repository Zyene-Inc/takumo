// What a shop can upload, and the fields Takumo needs from each kind of sheet.
// Synonyms drive the offline column matcher; the AI matcher sees labels and hints.

import { customers } from "./customers";
import { jobs } from "./jobs";
import { materials } from "./materials";
import { operations } from "./operations";
import { operators } from "./operators";
import { orders } from "./orders";
import { parts } from "./parts";
import { purchaseOrders } from "./purchase-orders";
import { quotes } from "./quotes";
import { routings } from "./routings";
import { stock } from "./stock";
import type { EntityDef, EntityKey } from "./types";
import { workCenters } from "./work-centers";

export type { EntityDef, EntityKey, FieldDef, FieldKind } from "./types";
export { ENTITY_KEYS } from "./types";

export const ENTITIES: Readonly<Record<EntityKey, EntityDef>> = {
  workCenters,
  customers,
  materials,
  parts,
  routings,
  orders,
  quotes,
  jobs,
  stock,
  purchaseOrders,
  operators,
  operations,
};

// A CSV header row users can download and fill in.
export const templateCsv = (entity: EntityKey) =>
  `${ENTITIES[entity].fields.map((f) => f.label).join(",")}\n`;

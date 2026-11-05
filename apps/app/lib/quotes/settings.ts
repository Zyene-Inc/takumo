import "server-only";

import { database, forOrg } from "@repo/database";
import type { OutsideSupplier, QuoteSettings } from "./types";

// Defaults when a shop hasn't said otherwise (docs/PRODUCT-PLAN.md F2.2-R5,
// F2.4, F2.5-R2).
export const QUOTE_DEFAULTS: QuoteSettings = {
  quoteValidityDays: 30,
  materialMarkup: 0.15,
  laborRate: 95,
  // Used only until the shop has won quotes with known costs, so a new shop
  // still gets priced drafts. The build-up says where it came from.
  defaultMargin: 0.25,
  toleranceIn: 0.0005,
  certifications: [],
  outsideProcesses: [],
  signature: null,
  replyIntro: null,
};

const supplierList = (value: unknown): OutsideSupplier[] =>
  Array.isArray(value)
    ? value.filter(
        (v): v is OutsideSupplier =>
          !!v && typeof v === "object" && typeof v.process === "string"
      )
    : [];

/** A shop's quoting settings, defaults filled in. */
export const quoteSettings = async (orgId: string): Promise<QuoteSettings> => {
  const row = await forOrg(database, orgId).shopSettings.findFirst();
  if (!row) {
    return QUOTE_DEFAULTS;
  }
  return {
    quoteValidityDays:
      row.quoteValidityDays ?? QUOTE_DEFAULTS.quoteValidityDays,
    materialMarkup: row.materialMarkup ?? QUOTE_DEFAULTS.materialMarkup,
    laborRate: row.laborRate ?? QUOTE_DEFAULTS.laborRate,
    defaultMargin: row.defaultMargin ?? QUOTE_DEFAULTS.defaultMargin,
    toleranceIn: row.toleranceIn ?? QUOTE_DEFAULTS.toleranceIn,
    certifications: row.certifications,
    outsideProcesses: supplierList(row.outsideProcesses),
    signature: row.signature,
    replyIntro: row.replyIntro,
  };
};

import "server-only";

import { database } from "@repo/database";

/**
 * Restricted and confidential documents are switched off in code until every
 * AI path (search, facts, the Brain, conversation history, email) enforces
 * document permissions (Knowledge Hub phase 4). Until then no shop can
 * restrict access, whatever its libraryStage says.
 */
const CONFIDENTIAL_READY = false;

export const NOT_YET = "Restricting who can see documents isn't available yet.";

/**
 * Whether the shop uses the Company Knowledge Library (/library): its
 * libraryStage is "library" (or "confidential", which can't be reached yet).
 * When it's "off", only the Knowledge pages are shown, as before.
 */
export const libraryEnabled = async (orgId: string) => {
  const org = await database.org.findUnique({
    where: { id: orgId },
    select: { libraryStage: true },
  });
  return Boolean(org && org.libraryStage !== "off");
};

/** Whether this shop may restrict access to folders and documents. */
export const confidentialEnabled = async (orgId: string) => {
  if (!CONFIDENTIAL_READY) {
    return false;
  }
  const org = await database.org.findUnique({
    where: { id: orgId },
    select: { libraryStage: true },
  });
  return org?.libraryStage === "confidential";
};

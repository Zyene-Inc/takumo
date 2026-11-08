import "server-only";

import { database } from "@repo/database";

/**
 * Whether owners may turn on restricted access (Knowledge Hub gate G3:
 * every AI path enforces document permissions, independently reviewed).
 * It only lets shops start restricting: turning it on is one way, so a shop
 * that already restricts documents keeps restricting even if this is set
 * back to false. Setting it back to false (to stop new shops turning it on)
 * must never open a shop's confidential folders to everyone.
 */
const CONFIDENTIAL_READY = true;

export const NOT_YET = "Restricting who can see documents isn't available yet.";

/** Whether an owner may turn restricted access on now (the switch above). */
export const restrictedAccessReady = () => CONFIDENTIAL_READY;

/**
 * Whether the shop uses the Company Knowledge Library (/library): its
 * libraryStage is "library" or "confidential". When it's "off", only the
 * Knowledge pages are shown, as before.
 */
export const libraryEnabled = async (orgId: string) => {
  const org = await database.org.findUnique({
    where: { id: orgId },
    select: { libraryStage: true },
  });
  return Boolean(org && org.libraryStage !== "off");
};

/**
 * Whether this shop restricts access to folders and documents: its owner
 * turned restricted access on (libraryStage "confidential", one way). Not
 * tied to the switch above, so switching that off never widens access.
 */
export const confidentialEnabled = async (orgId: string) => {
  const org = await database.org.findUnique({
    where: { id: orgId },
    select: { libraryStage: true },
  });
  return org?.libraryStage === "confidential";
};

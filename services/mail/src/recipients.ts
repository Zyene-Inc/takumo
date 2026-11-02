// Which envelope recipients we accept: erp-/rfq-/docs-/ask- addresses with a
// token, at one of our domains. The app checks that the token belongs to a shop.
const LOCAL_PART = /^(erp|rfq|docs|ask)-[a-z0-9]{8,32}$/;

export const MAX_RECIPIENTS = 20;

/**
 * Returns the normalized (lowercased) address when it is one of ours, or null.
 */
export function acceptRecipient(
  address: string,
  domains: readonly string[]
): string | null {
  const normalized = address.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0) {
    return null;
  }
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (!domains.includes(domain)) {
    return null;
  }
  return LOCAL_PART.test(local) ? normalized : null;
}

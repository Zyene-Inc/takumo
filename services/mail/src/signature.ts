// The webhook signature: lowercase hex HMAC-SHA256, keyed with
// INBOUND_EMAIL_SECRET, over `${timestamp}.${recipients}.${mailFrom}.` followed
// immediately by the raw message bytes.
import { createHmac } from "node:crypto";

export interface SignedFields {
  mailFrom: string;
  recipients: string;
  timestamp: string;
}

export function sign(
  secret: string,
  fields: SignedFields,
  body: Buffer
): string {
  return createHmac("sha256", secret)
    .update(
      `${fields.timestamp}.${fields.recipients}.${fields.mailFrom}.`,
      "utf8"
    )
    .update(body)
    .digest("hex");
}

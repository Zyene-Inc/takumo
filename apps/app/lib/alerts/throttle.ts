// Who gets which alerts now (docs/PRODUCT-PLAN.md F4.3-R2): the types their
// role can act on and hasn't turned off, at most one email per type an hour,
// with everything found since their last one batched into it. Pure, so tested.

import { type AlertType, alertTypesFor } from "./detect";

export const ALERT_EVERY_MS = 60 * 60 * 1000;
/** Someone's first alert covers no more than the last day. */
export const FIRST_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface StoredEvent {
  createdAt: Date;
  id: string;
  message: string;
  path: string;
  quiet: boolean;
  type: string;
}

interface AlertRecipient {
  off: readonly string[];
  role: string | null;
  userId: string;
}

interface Delivery {
  events: StoredEvent[];
  type: AlertType;
  userId: string;
}

/** `sent`: when each person last got each type, keyed `${userId}|${type}`. */
export const deliveries = (
  events: StoredEvent[],
  recipients: AlertRecipient[],
  sent: ReadonlyMap<string, Date>,
  now: Date
): Delivery[] => {
  const out: Delivery[] = [];
  for (const r of recipients) {
    for (const type of alertTypesFor(r.role)) {
      if (r.off.includes(type)) {
        continue;
      }
      const last = sent.get(`${r.userId}|${type}`);
      if (last && now.getTime() - last.getTime() < ALERT_EVERY_MS) {
        continue;
      }
      const since = last ?? new Date(now.getTime() - FIRST_LOOKBACK_MS);
      const batch = events
        .filter(
          (e) =>
            e.type === type &&
            !e.quiet &&
            e.createdAt.getTime() > since.getTime() &&
            e.createdAt.getTime() <= now.getTime()
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      if (batch.length) {
        out.push({ userId: r.userId, type, events: batch });
      }
    }
  }
  return out;
};

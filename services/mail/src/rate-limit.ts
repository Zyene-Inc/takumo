// A per-key token bucket held in memory. Each key starts full (`capacity`
// tokens) and refills at `capacity` tokens per `windowMs`.

interface Bucket {
  tokens: number;
  updated: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;
  private readonly maxKeys: number;
  private lastSweep = Number.NEGATIVE_INFINITY;

  constructor(
    capacity: number,
    windowMs: number,
    now: () => number = Date.now,
    maxKeys = 100_000
  ) {
    this.capacity = capacity;
    this.refillPerMs = capacity / windowMs;
    this.now = now;
    this.maxKeys = maxKeys;
  }

  /** Takes one token for `key`; false when the bucket is empty. */
  take(key: string): boolean {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (bucket) {
      bucket.tokens = Math.min(
        this.capacity,
        bucket.tokens + (now - bucket.updated) * this.refillPerMs
      );
      bucket.updated = now;
    } else {
      if (this.buckets.size >= this.maxKeys) {
        if (now - this.lastSweep >= 1000) {
          this.sweep();
        }
        // Still full (a flood from many addresses): forget the oldest entry.
        const oldest = this.buckets.keys().next();
        if (this.buckets.size >= this.maxKeys && !oldest.done) {
          this.buckets.delete(oldest.value);
        }
      }
      bucket = { tokens: this.capacity, updated: now };
      this.buckets.set(key, bucket);
    }
    if (bucket.tokens < 1) {
      return false;
    }
    bucket.tokens -= 1;
    return true;
  }

  /** Drops buckets that have refilled completely; they behave like new ones. */
  sweep(): void {
    const now = this.now();
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (
        bucket.tokens + (now - bucket.updated) * this.refillPerMs >=
        this.capacity
      ) {
        this.buckets.delete(key);
      }
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}

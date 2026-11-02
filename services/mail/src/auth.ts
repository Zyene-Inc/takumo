// SPF, DKIM and DMARC for a received message (mailauth), reduced to the small
// summary the app gets in X-Takumo-Auth.
import { type AuthenticateOptions, authenticate } from "mailauth";
import type { AuthSummary } from "./webhook.js";

const SPF_RESULTS = new Set([
  "pass",
  "fail",
  "softfail",
  "neutral",
  "none",
  "temperror",
  "permerror",
]);

export type DnsResolver = NonNullable<AuthenticateOptions["resolver"]>;

export interface AuthInput {
  helo: string;
  ip: string;
  mailFrom: string;
  mta: string;
  raw: Buffer;
  resolver?: DnsResolver;
}

export async function checkAuth(input: AuthInput): Promise<AuthSummary> {
  try {
    const result = await authenticate(input.raw, {
      ip: input.ip,
      helo: input.helo,
      sender: input.mailFrom,
      mta: input.mta,
      disableArc: true,
      disableBimi: true,
      ...(input.resolver ? { resolver: input.resolver } : {}),
    });

    const spfResult = result.spf ? result.spf.status.result : "none";
    const spf = spfResult === "temperr" ? "temperror" : spfResult;

    const signatures = result.dkim.results ?? [];
    const passing = signatures.filter((s) => s.status.result === "pass");
    const signed = signatures.some((s) => s.status.result !== "none");
    const dkimDomains = [
      ...new Set(
        passing.map((s) => s.signingDomain?.toLowerCase()).filter(Boolean)
      ),
    ] as string[];

    // The contract only has pass|fail|none for DMARC: temperror, permerror and
    // "can't evaluate" (dmarc === false) are reported as none.
    const dmarcResult = result.dmarc ? result.dmarc.status.result : "none";

    let dkim: AuthSummary["dkim"] = "none";
    if (passing.length > 0) {
      dkim = "pass";
    } else if (signed) {
      dkim = "fail";
    }

    return {
      spf: SPF_RESULTS.has(spf) ? spf : "none",
      dkim,
      dkimDomains,
      dmarc:
        dmarcResult === "pass" || dmarcResult === "fail" ? dmarcResult : "none",
      from: result.dkim.headerFrom?.[0] ?? "",
    };
  } catch {
    // A message mailauth can't parse at all: nothing is authenticated.
    return {
      spf: "temperror",
      dkim: "none",
      dkimDomains: [],
      dmarc: "none",
      from: "",
    };
  }
}

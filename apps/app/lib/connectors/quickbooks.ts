// QuickBooks Online: OAuth 2.0 and the data Takumo reads. Customers (with
// payment terms) and estimates (past quotes, won and lost) go through the
// same import as uploaded sheets. Mappers are pure; HTTP calls take `fetch`
// so they're tested without the network.

import type { ParsedRecord } from "@repo/ingest";
import { normalizePartNo } from "../quotes/match";

export const QB_AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
export const QB_TOKEN_URL =
  "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
export const QB_REVOKE_URL =
  "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
export const QB_SCOPE = "com.intuit.quickbooks.accounting";
const QB_API = {
  sandbox: "https://sandbox-quickbooks.api.intuit.com",
  production: "https://quickbooks.api.intuit.com",
} as const;
const MINOR_VERSION = "75";
const PAGE = 1000;
/** Estimates older than this aren't imported (pricing history worth keeping). */
export const ESTIMATE_YEARS = 3;

export type QbEnvironment = keyof typeof QB_API;

export interface QbCustomer {
  Active?: boolean;
  DisplayName: string;
  Id: string;
  SalesTermRef?: { value: string };
}

export interface QbTerm {
  DueDays?: number;
  Id: string;
}

export interface QbLine {
  Amount?: number;
  DetailType: string;
  SalesItemLineDetail?: {
    ItemRef?: { name?: string; value: string };
    Qty?: number;
  };
}

export interface QbEstimate {
  CustomerRef?: { name?: string; value: string };
  DocNumber?: string;
  Id: string;
  Line?: QbLine[];
  TotalAmt?: number;
  TxnDate?: string;
  TxnStatus?: string;
}

export const authorizeUrl = (
  clientId: string,
  redirectUri: string,
  state: string
) => {
  const url = new URL(QB_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: QB_SCOPE,
    state,
  }).toString();
  return url.toString();
};

const ESTIMATE_STATUS: Record<string, "won" | "lost" | "open"> = {
  Accepted: "won",
  Closed: "won",
  Converted: "won",
  Rejected: "lost",
  Pending: "open",
};

/** Customers, with payment terms in days where QuickBooks has them. */
export const customerRecords = (
  customers: QbCustomer[],
  terms: QbTerm[]
): ParsedRecord[] => {
  const dueDays = new Map(terms.map((t) => [t.Id, t.DueDays]));
  return customers
    .filter((c) => c.Active !== false && c.DisplayName?.trim())
    .map((c, i) => {
      const days = c.SalesTermRef
        ? dueDays.get(c.SalesTermRef.value)
        : undefined;
      return {
        row: i + 1,
        values: {
          name: c.DisplayName.trim(),
          ...(typeof days === "number" ? { paymentTermDays: days } : {}),
        },
      };
    });
};

/** "Machined parts:P-1001" → "P-1001" (QuickBooks sub-items). */
const itemName = (line: QbLine) => {
  const name = line.SalesItemLineDetail?.ItemRef?.name ?? "";
  return name.split(":").at(-1)?.trim() ?? "";
};

/**
 * One past quote per estimate. Its part is the first line that names a part
 * the shop makes (charges like "Setup" or "Freight" never become parts);
 * the price is the estimate's total.
 */
export const estimateRecords = (
  estimates: QbEstimate[],
  shopPartNos: string[]
): ParsedRecord[] => {
  const known = new Map(shopPartNos.map((p) => [normalizePartNo(p), p]));
  const records: ParsedRecord[] = [];
  estimates.forEach((e, i) => {
    const lines = (e.Line ?? []).filter(
      (l) =>
        l.DetailType === "SalesItemLineDetail" &&
        (l.SalesItemLineDetail?.Qty ?? 0) > 0
    );
    if (lines.length === 0) {
      return;
    }
    const partLine = lines.find((l) => known.has(normalizePartNo(itemName(l))));
    const line =
      partLine ??
      [...lines].sort((a, b) => (b.Amount ?? 0) - (a.Amount ?? 0))[0];
    records.push({
      row: i + 1,
      values: {
        quoteNo: e.DocNumber?.trim() || `QB-${e.Id}`,
        qty: Math.round(line.SalesItemLineDetail?.Qty ?? 0),
        customer: e.CustomerRef?.name?.trim() || null,
        partNo: partLine
          ? (known.get(normalizePartNo(itemName(partLine))) ?? null)
          : null,
        price: e.TotalAmt ?? null,
        status: ESTIMATE_STATUS[e.TxnStatus ?? ""] ?? "open",
        quotedAt: e.TxnDate ?? null,
      },
    });
  });
  return records;
};

type Fetch = typeof fetch;

export interface QbTokens {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  x_refresh_token_expires_in?: number;
}

const tokenRequest = async (
  fetcher: Fetch,
  clientId: string,
  clientSecret: string,
  body: Record<string, string>
) => {
  const response = await fetcher(QB_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body),
  });
  if (!response.ok) {
    throw new Error(`QuickBooks refused the sign-in (${response.status}).`);
  }
  return (await response.json()) as QbTokens;
};

export const exchangeCode = (
  fetcher: Fetch,
  creds: { clientId: string; clientSecret: string; redirectUri: string },
  code: string
) =>
  tokenRequest(fetcher, creds.clientId, creds.clientSecret, {
    grant_type: "authorization_code",
    code,
    redirect_uri: creds.redirectUri,
  });

export const refreshTokens = (
  fetcher: Fetch,
  creds: { clientId: string; clientSecret: string },
  refreshToken: string
) =>
  tokenRequest(fetcher, creds.clientId, creds.clientSecret, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

export const revokeToken = async (
  fetcher: Fetch,
  creds: { clientId: string; clientSecret: string },
  token: string
) => {
  await fetcher(QB_REVOKE_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64")}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ token }),
  });
};

export class QbAuthError extends Error {}

/** Every row of a QuickBooks query, page by page. */
export const queryAll = async <T>(
  fetcher: Fetch,
  env: QbEnvironment,
  realmId: string,
  accessToken: string,
  entity: string,
  where = ""
): Promise<T[]> => {
  const rows: T[] = [];
  for (let start = 1; ; start += PAGE) {
    const query = `select * from ${entity}${where ? ` where ${where}` : ""} startposition ${start} maxresults ${PAGE}`;
    const url = `${QB_API[env]}/v3/company/${encodeURIComponent(realmId)}/query?${new URLSearchParams(
      {
        query,
        minorversion: MINOR_VERSION,
      }
    )}`;
    const response = await fetcher(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    if (response.status === 401) {
      throw new QbAuthError("QuickBooks access expired. Reconnect it.");
    }
    if (!response.ok) {
      throw new Error(`QuickBooks returned an error (${response.status}).`);
    }
    const body = (await response.json()) as {
      QueryResponse?: Record<string, unknown>;
    };
    const page = (body.QueryResponse?.[entity] as T[] | undefined) ?? [];
    rows.push(...page);
    if (page.length < PAGE) {
      return rows;
    }
  }
};

export const companyName = async (
  fetcher: Fetch,
  env: QbEnvironment,
  realmId: string,
  accessToken: string
) => {
  const response = await fetcher(
    `${QB_API[env]}/v3/company/${encodeURIComponent(realmId)}/companyinfo/${encodeURIComponent(realmId)}?minorversion=${MINOR_VERSION}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    }
  );
  if (!response.ok) {
    return null;
  }
  const body = (await response.json()) as {
    CompanyInfo?: { CompanyName?: string };
  };
  return body.CompanyInfo?.CompanyName ?? null;
};

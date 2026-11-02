// How to recognise a customer's email: contact addresses and company domains,
// read from whatever the ERP's customer report lists. Pure.

/**
 * Shared mail services: someone writing from one doesn't vouch for everyone
 * else there, so those are matched by full address, never by domain.
 */
export const SHARED_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "mail.com",
]);

const EMAIL = /[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const HOST = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:www\.)?([a-z0-9.-]+\.[a-z]{2,})/i;

/** Every address in a cell like "Jo <jo@acme.com>; buyer@acme.com". */
export const emailsIn = (text: string | null | undefined) => [
  ...new Set((text ?? "").match(EMAIL)?.map((e) => e.toLowerCase()) ?? []),
];

/** A website or domain cell ("https://www.acme.com/contact") → "acme.com". */
export const domainOfSite = (text: string | null | undefined) => {
  const host = (text ?? "").trim().match(HOST)?.[1]?.toLowerCase();
  return host && !SHARED_DOMAINS.has(host) ? host : null;
};

/** Company domains: from the website, and from addresses not on shared mail. */
export const companyDomains = (emails: string[], website?: string | null) => {
  const domains = new Set<string>();
  const site = domainOfSite(website);
  if (site) {
    domains.add(site);
  }
  for (const email of emails) {
    const domain = email.slice(email.lastIndexOf("@") + 1);
    if (domain && !SHARED_DOMAINS.has(domain)) {
      domains.add(domain);
    }
  }
  return [...domains];
};

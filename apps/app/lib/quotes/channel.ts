// Which channel an emailed RFQ really came through (docs/PRODUCT-PLAN.md
// F2.1-R6): a customer portal's notification, a website contact form, or a
// person's email. Phone calls and uploads are chosen by the estimator. Pure.

import { senderAddress } from "./attachments";

/** Domains that send customer-portal and sourcing-event notifications. */
const PORTAL_DOMAINS = [
  "ariba.com",
  "ansmtp.ariba.com",
  "coupahost.com",
  "coupa.com",
  "jaggaer.com",
  "sciquest.com",
  "plex.com",
  "paperlessparts.com",
  "xometry.com",
  "fictiv.com",
  "protolabs.com",
  "ivalua.com",
  "gep.com",
  "zycus.com",
  "bonfirehub.com",
  "esourcing.com",
  "supplier.io",
  "tradecentric.com",
  "tradeshift.com",
  "oraclecloud.com",
  "salesforce-sites.com",
  "mfg.com",
  "quotewerks.com",
] as const;

/** Domains of website form services that email each submission. */
const FORM_DOMAINS = [
  "formspree.io",
  "jotform.com",
  "wufoo.com",
  "typeform.com",
  "cognitoforms.com",
  "formstack.com",
  "webflow.com",
  "squarespace.info",
  "wix-forms.com",
  "wixemails.com",
  "hubspot.com",
  "hsforms.com",
  "gravityforms.com",
  "wpforms.com",
  "123formbuilder.com",
  "zohoforms.com",
  "getform.io",
  "basin.io",
  "netlify.com",
] as const;

const PORTAL_WORDS = /supplier[-_ ]?portal|sourcing|e-?procurement|rfx/i;
const FORM_LOCAL =
  /^(wordpress|wpforms|forms?|webform|contact[-_.]?form|website)@/i;
const FORM_SUBJECT =
  /(new|website)\s+(form\s+)?(submission|inquiry|enquiry|lead)|contact\s+form|form\s+submission|quote\s+request\s+form|request\s+a\s+quote\s+form/i;
// "Name: …", "Email: …" lines of a form mailer.
const FORM_FIELD =
  /^\s*(name|full name|first name|last name|your name|e-?mail|email address|phone|phone number|company|company name|message|comments?|details|project details|quantity|part number)\s*[:=]/gim;
const FORM_MESSAGE = /^\s*(message|comments?|details|project details)\s*[:=]/im;
const FORM_EMAIL = /^\s*(e-?mail|email address)\s*[:=]/im;

const domainOf = (address: string | null) =>
  address ? address.slice(address.lastIndexOf("@") + 1) : null;

const underDomain = (domain: string | null, list: readonly string[]) =>
  !!domain && list.some((d) => domain === d || domain.endsWith(`.${d}`));

/** True when a body reads like a form mailer's "Name: … Email: …" list. */
export const looksLikeForm = (body: string) => {
  const head = body.slice(0, 4000);
  const fields = new Set(
    [...head.matchAll(FORM_FIELD)].map((m) => m[1].toLowerCase())
  );
  return fields.size >= 3 && FORM_EMAIL.test(head) && FORM_MESSAGE.test(head);
};

/** The channel of an RFQ that arrived as an email. */
export const channelOf = (input: {
  body: string;
  sender: string | null;
  subject: string | null;
}): "portal" | "form" | "email" => {
  const address = senderAddress(input.sender);
  const domain = domainOf(address);
  if (
    underDomain(domain, PORTAL_DOMAINS) ||
    (domain !== null && PORTAL_WORDS.test(domain))
  ) {
    return "portal";
  }
  if (
    underDomain(domain, FORM_DOMAINS) ||
    (address !== null && FORM_LOCAL.test(address)) ||
    FORM_SUBJECT.test(input.subject ?? "") ||
    looksLikeForm(input.body)
  ) {
    return "form";
  }
  return "email";
};

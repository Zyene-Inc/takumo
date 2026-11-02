import { describe, expect, it } from "vitest";
import { companyDomains, domainOfSite, emailsIn } from "../contacts";

describe("customer contacts from an ERP report", () => {
  it("finds every address in a cell", () => {
    expect(emailsIn("Jo <Jo@Acme.com>; buyer@acme.com, jo@acme.com")).toEqual([
      "jo@acme.com",
      "buyer@acme.com",
    ]);
    expect(emailsIn(null)).toEqual([]);
  });

  it("reads a website as a domain, never a shared mail one", () => {
    expect(domainOfSite("https://www.acme.com/contact")).toBe("acme.com");
    expect(domainOfSite("acme.co.uk")).toBe("acme.co.uk");
    expect(domainOfSite("gmail.com")).toBeNull();
    expect(domainOfSite("")).toBeNull();
  });

  it("collects company domains from addresses and the website", () => {
    expect(
      companyDomains(["jo@acme.com", "x@gmail.com"], "https://parts.acme.com")
    ).toEqual(["parts.acme.com", "acme.com"]);
  });
});

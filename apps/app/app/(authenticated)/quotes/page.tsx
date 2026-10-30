import type { Metadata } from "next";
import { ModulePlaceholder } from "../components/module-placeholder";

export const metadata: Metadata = { title: "Quotes · Takumo" };

const Page = () => (
  <ModulePlaceholder
    description="RFQ inbox and Quote Copilot: extract the RFQ, find comparable past jobs, and draft a price and lead time based on current capacity for an estimator to approve."
    phase="Phase 4 · weeks 11–13"
    section="Takumo"
    title="Quotes"
  />
);

export default Page;

import type { Metadata } from "next";
import { ModulePlaceholder } from "../components/module-placeholder";

export const metadata: Metadata = { title: "Ask Takumo · Takumo" };

const Page = () => (
  <ModulePlaceholder
    description="Chat across your shop data. Every number comes from the engines or your data, with citations. Includes the capacity check: can we take this order, by when, and at what margin?"
    phase="Phase 3 · weeks 9–10"
    section="Takumo"
    title="Ask Takumo"
  />
);

export default Page;

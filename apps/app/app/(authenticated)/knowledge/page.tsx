import type { Metadata } from "next";
import { ModulePlaceholder } from "../components/module-placeholder";

export const metadata: Metadata = { title: "Knowledge · Takumo" };

const Page = () => (
  <ModulePlaceholder
    description="Uploaded sources and tribal-knowledge facts. New facts supersede old ones and wait for review before they change the model."
    phase="Phase 5 · weeks 14–16"
    section="Takumo"
    title="Knowledge"
  />
);

export default Page;

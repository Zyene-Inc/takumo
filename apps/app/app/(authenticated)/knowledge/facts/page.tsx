import type { Metadata } from "next";
import { ModulePlaceholder } from "../../components/module-placeholder";

export const metadata: Metadata = { title: "Facts to review · Takumo" };

const Page = () => (
  <ModulePlaceholder
    description="Corrections from chat and operator voice notes become facts (e.g. 'Machine 4 setup for 316 stainless is 90 min, not 45'). A supervisor approves them before they change the model."
    phase="Phase 5 · weeks 14–16"
    section="Knowledge"
    title="Facts to review"
  />
);

export default Page;

import type { Metadata } from "next";
import { ModulePlaceholder } from "../components/module-placeholder";

export const metadata: Metadata = { title: "Shop · Takumo" };

const Page = () => (
  <ModulePlaceholder
    description="Work centers, parts, routings and orders: the factory model every answer is computed from."
    phase="Phase 1 · weeks 3–5"
    section="Takumo"
    title="Shop"
  />
);

export default Page;

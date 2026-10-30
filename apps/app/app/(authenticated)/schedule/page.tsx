import type { Metadata } from "next";
import { ModulePlaceholder } from "../components/module-placeholder";

export const metadata: Metadata = { title: "Schedule · Takumo" };

const Page = () => (
  <ModulePlaceholder
    description="Gantt board by work center, built by the CP-SAT scheduler in services/engine, with late-order and conflict flags."
    phase="Phase 2 · weeks 6–8"
    section="Takumo"
    title="Schedule"
  />
);

export default Page;

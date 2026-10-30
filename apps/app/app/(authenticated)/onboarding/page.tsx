import type { Metadata } from "next";
import { ModulePlaceholder } from "../components/module-placeholder";

export const metadata: Metadata = { title: "Set up your shop · Takumo" };

const Page = () => (
  <ModulePlaceholder
    description="Upload machines, routings, open orders and past quotes (CSV/XLSX). Takumo maps the columns and asks you to confirm before building the model."
    phase="Phase 1 · weeks 3–5"
    section="Takumo"
    title="Set up your shop"
  />
);

export default Page;

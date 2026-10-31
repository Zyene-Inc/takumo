import type { Metadata } from "next";
import Link from "next/link";
import { ARTICLES } from "@/lib/help/articles";
import { Header } from "../components/header";

export const metadata: Metadata = { title: "Help · Takumo" };

const HelpPage = () => (
  <>
    <Header page="Help" pages={["Takumo"]} />
    <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
      <p className="text-muted-foreground text-sm">
        Short guides to each part of Takumo. Stuck on something else? Ask
        Takumo, or email the Takumo team from your onboarding email.
      </p>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {ARTICLES.map((a) => (
          <Link
            className="rounded-xl border p-4 hover:bg-muted/50"
            href={`/help/${a.slug}`}
            key={a.slug}
          >
            <h2 className="font-medium">{a.title}</h2>
            <p className="mt-1 text-muted-foreground text-sm">{a.summary}</p>
          </Link>
        ))}
      </div>
    </div>
  </>
);

export default HelpPage;

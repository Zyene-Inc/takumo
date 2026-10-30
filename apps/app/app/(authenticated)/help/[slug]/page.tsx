import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ARTICLES, article } from "@/lib/help/articles";
import { Header } from "../../components/header";
import { ArticleBody } from "./article-body";

export const generateStaticParams = () =>
  ARTICLES.map((a) => ({ slug: a.slug }));

export const generateMetadata = async ({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> => {
  const a = article((await params).slug);
  return { title: a ? `${a.title} · Help · Takumo` : "Help · Takumo" };
};

const HelpArticlePage = async ({
  params,
}: {
  params: Promise<{ slug: string }>;
}) => {
  const a = article((await params).slug);
  if (!a) {
    notFound();
  }
  return (
    <>
      <Header page={a.title} pages={["Help"]} />
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <h1 className="font-semibold text-2xl">{a.title}</h1>
        <ArticleBody markdown={a.body} />
        <Link className="text-sm underline" href="/help">
          All help topics
        </Link>
      </div>
    </>
  );
};

export default HelpArticlePage;

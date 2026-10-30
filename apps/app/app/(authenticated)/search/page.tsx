import { auth } from "@repo/auth/server";
import { database, forOrg } from "@repo/database";
import { notFound, redirect } from "next/navigation";
import { Header } from "../components/header";

interface SearchPageProperties {
  searchParams: Promise<{
    q: string;
  }>;
}

export const generateMetadata = async ({
  searchParams,
}: SearchPageProperties) => {
  const { q } = await searchParams;

  return {
    title: `${q} - Search results`,
    description: `Search results for ${q}`,
  };
};

const SearchPage = async ({ searchParams }: SearchPageProperties) => {
  const { q } = await searchParams;
  const { orgId } = await auth();

  if (!orgId) {
    notFound();
  }

  if (!q) {
    redirect("/");
  }

  const parts = await forOrg(database, orgId).part.findMany({
    where: {
      OR: [
        { partNo: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
      ],
    },
    take: 30,
  });

  return (
    <>
      <Header page="Search" pages={["Shop"]} />
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <div className="grid auto-rows-min gap-4 md:grid-cols-3">
          {parts.map((part) => (
            <div className="rounded-xl bg-muted/50 p-4" key={part.id}>
              <p className="font-medium">{part.partNo}</p>
              <p className="text-muted-foreground text-sm">
                {part.description}
              </p>
            </div>
          ))}
        </div>
        <div className="min-h-[100vh] flex-1 rounded-xl bg-muted/50 md:min-h-min" />
      </div>
    </>
  );
};

export default SearchPage;

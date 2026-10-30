import { ENTITY_KEYS, type EntityKey, templateCsv } from "@repo/ingest";

export const GET = async (
  _request: Request,
  { params }: { params: Promise<{ entity: string }> }
) => {
  const { entity } = await params;
  if (!ENTITY_KEYS.includes(entity as EntityKey)) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(templateCsv(entity as EntityKey), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="takumo-${entity}.csv"`,
    },
  });
};

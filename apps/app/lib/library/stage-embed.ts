import "server-only";

import { embedMany } from "@repo/ai";
import { canEmbed, embeddingOptions, models } from "@repo/ai/lib/models";
import { database } from "@repo/database";
import { writeIfFull } from "./ai-mode";
import { renewLease, saveProgress } from "./lease";
import { mayUseAi, type Run } from "./stage-run";

const EMBED_BATCH = 64;

const vectorLiteral = (values: number[]) => `[${values.join(",")}]`;

const SET_EMBEDDINGS_SQL = `
  update "DocChunk" c set embedding = v.embedding::vector
  from unnest($1::text[], $2::text[]) as v(id, embedding)
  where c.id = v.id and c."versionId" = $3 and c.embedding is null`;

/**
 * Stage "embed": a vector for every passage still without one, in batches.
 * A failure fails the version (and it is retried), so a new version never
 * goes live searchable by keywords only while the old one had vectors.
 * Without an embedding model, keywords alone are used, as before.
 */
export const embed = async ({ lease, checkTime }: Run) => {
  const { orgId, sourceId } = lease.version;
  if (canEmbed && (await mayUseAi(lease))) {
    for (;;) {
      // Vectors are an Unsupported column in Prisma: find the passages
      // still without one in SQL.
      const missing = await database.$queryRawUnsafe<{ id: string }[]>(
        `select id from "DocChunk" where "versionId" = $1 and embedding is null
         order by ordinal limit $2`,
        lease.version.id,
        EMBED_BATCH
      );
      if (missing.length === 0) {
        break;
      }
      const batch = await database.docChunk.findMany({
        where: { id: { in: missing.map((m) => m.id) } },
        orderBy: { ordinal: "asc" },
        select: { id: true, content: true, meta: true },
      });
      // Checked before every batch: nothing more is sent once it's lowered.
      if (!(await mayUseAi(lease))) {
        break;
      }
      const { embeddings } = await embedMany({
        model: models.embeddings,
        // The context sentence goes into the vector too.
        values: batch.map((c) => {
          const context = (c.meta as { context?: string } | null)?.context;
          return context ? `${context}\n\n${c.content}` : c.content;
        }),
        ...embeddingOptions("document"),
      });
      await renewLease(lease);
      const wrote = await writeIfFull(orgId, sourceId, (tx) =>
        tx.$executeRawUnsafe(
          SET_EMBEDDINGS_SQL,
          batch.map((c) => c.id),
          embeddings.map(vectorLiteral),
          lease.version.id
        )
      );
      if (!wrote) {
        break;
      }
      checkTime();
    }
  }
  await saveProgress(lease, { stage: "activate" });
};

// The version goes live only if no newer one already has. The document row
// is locked so two versions finishing at once take turns.

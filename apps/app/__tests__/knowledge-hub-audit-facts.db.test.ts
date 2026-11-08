// @vitest-environment node
// This file: C1 and M4. H2 is in knowledge-hub-audit-restricted.db.test.ts
// (same setup).
// Security audit regressions (Knowledge Hub phase 4), facts:
// - C1: Ask Takumo's SQL tool showed restricted fact values through
//   database error messages ("invalid input syntax … <value>"). It is now off
//   unless ASK_SQL_ENABLED is exactly "true", the ask views are security
//   barriers and errors are generic, with a reference.
// - M4: adding a fact by hand (or in a note) with a guessed value returned
//   the number of a hidden pending fact with the same value.
// - H2: a fact read from a restricted document was merged into a fact a
//   person typed (shown to everyone); deleting the other document then
//   copied the restricted quote into the fact's evidence, and the evidence
//   flag ignored the documents attached to a typed fact.
// Ends with the auditor's marker sweep: restricted words never reach people
// who may not use their documents, through any loader. These are the
// auditor's exploit steps, asserting they now fail. Restricted access is
// switched off in code; these tests switch it on. No AI service is called.
// Needs TEST_DATABASE_URL and TEST_ASK_DATABASE_URL (takumo_reader).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const READER = process.env.TEST_ASK_DATABASE_URL;
process.env.ASK_DATABASE_URL = READER;
process.env.SKIP_ENV_VALIDATION = "true";
Reflect.deleteProperty(process.env, "ASK_SQL_ENABLED");

const h = vi.hoisted(() => ({
  session: { orgId: "", userId: "", role: "" },
  /** What the (mocked) model reads from a note. */
  noteFacts: [] as Record<string, unknown>[],
}));

vi.mock("server-only", () => ({}));
vi.mock("../../../packages/database/node_modules/server-only", () => ({}));
vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../lib/analytics", () => ({ track: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../lib/ai-usage", () => ({
  budgetProblem: async () => null,
  recordUsage: vi.fn(),
  recordFailedUsage: vi.fn(),
}));
// Reading a note asks a model; here it returns h.noteFacts.
vi.mock("@repo/ai", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  generateText: async () => ({
    output: { facts: h.noteFacts },
    usage: {},
    finalStep: { response: { modelId: "test" } },
  }),
  streamText: () => {
    throw new Error("An AI service was called");
  },
}));

// Active WorkOS memberships, "shop:user" → role (WorkOS is mocked).
const members = new Map<string, string>();
vi.mock("@repo/auth/server", () => ({
  auth: async () => ({ ...h.session }),
  shopRole: async (userId: string, orgId: string) =>
    members.get(`${orgId}:${userId}`) ?? null,
  listShopMembers: async () => [],
}));
vi.mock("../lib/library/stage", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  confidentialEnabled: async () => true,
  restrictedAccessReady: () => true,
}));

type Db = typeof import("@repo/database");
type Viewer = import("../lib/library/viewer").Viewer;

const id = () => randomUUID();

const HR = "CONFIDENTIAL_HR_TEST_92741";
const FIN = "CONFIDENTIAL_FIN_TEST_55018";
const FIN_VALUE = "55.018";
const ORG_B = "ORG_B_ONLY_33310";
const markers = (value: unknown) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return [HR, FIN, ORG_B].filter((m) => text.includes(m));
};
// The database's own error words, which can quote a row's value.
const RAW_POSTGRES = /invalid input syntax|does not exist|division by zero/;
const REF = /\(ref [0-9a-f]{8}\)/;

describe.skipIf(!(TEST_DATABASE_URL && READER))(
  "security audit: facts (C1, M4, H2)",
  () => {
    const A = `org_audit_facts_${id().slice(0, 8)}`;
    const B = `org_audit_factsb_${id().slice(0, 8)}`;
    let database: Db["database"];
    let reader: typeof import("@repo/database/reader");
    let viewers: typeof import("../lib/library/viewer");
    let aiAccess: typeof import("../lib/library/ai-access");
    let facts: typeof import("../lib/facts/facts");

    const folder = { general: id(), hr: id(), fin: id() };
    const dept = { hr: id(), fin: id(), eng: id() };
    const doc = {
      pub: "",
      pub2: "",
      pub3: "",
      pub4: "",
      pub5: "",
      hr: "",
      fin: "",
    };
    const rec = { part: "", wc: "", mat: "", mat2: "", cust: "", routing: "" };
    const fact: Record<string, string> = {};

    const as = async (orgId: string, userId: string): Promise<Viewer> => {
      const v = await viewers.viewerForMember(orgId, userId);
      if (!v) {
        throw new Error(`${userId} isn't a member`);
      }
      return v;
    };
    const signIn = (userId: string) => {
      h.session = {
        orgId: A,
        userId,
        role: members.get(`${A}:${userId}`) ?? "",
      };
    };

    const addDoc = async (
      orgId: string,
      name: string,
      folderId: string | null,
      body: string
    ) => {
      const sourceId = id();
      const versionId = id();
      await database.source.create({
        data: {
          id: sourceId,
          orgId,
          name,
          type: "upload",
          profile: "document",
          folderId,
          status: "ready",
          uploadedBy: "u_owner",
        },
      });
      await database.documentVersion.create({
        data: {
          id: versionId,
          orgId,
          sourceId,
          number: 1,
          name,
          status: "ready",
          stage: "done",
          activatedAt: new Date(),
        },
      });
      await database.source.update({
        where: { id: sourceId },
        data: { currentVersionId: versionId, versionSeq: 1 },
      });
      await database.docChunk.create({
        data: {
          orgId,
          sourceId,
          versionId,
          ordinal: 0,
          content: body,
          page: 1,
          meta: {},
        },
      });
      return sourceId;
    };

    /** A fact as the pipeline (or an older version of Takumo) wrote it. */
    const mkFact = async (
      data: Record<string, unknown>,
      sources: { id: string; quote: string }[] = []
    ) => {
      // After the facts proposeFact numbered (it takes the highest + 1).
      const last = await database.fact.findFirst({
        where: { orgId: A },
        orderBy: { number: "desc" },
        select: { number: true },
      });
      const made = await database.fact.create({
        data: {
          orgId: A,
          number: Math.max(last?.number ?? 0, 500) + 1,
          subjectType: "part",
          subjectId: rec.part,
          subjectLabel: "P-AUD rev A",
          attribute: "note",
          value: "x",
          source: "document",
          status: "pending",
          provenance: sources.length ? "documents" : "none",
          ...data,
          sources: {
            create: sources.map((s) => ({
              orgId: A,
              sourceId: s.id,
              quote: s.quote,
            })),
          },
        } as never,
      });
      return made.id;
    };

    /** A fact the pipeline reads from a document (no AI: the result is given). */

    /** What each person is shown of a fact's evidence. */

    const dataTool = async (userId: string) => {
      const { dataTools } = await import("../lib/agent/tools/data");
      const tools = dataTools(
        { orgId: A, userId, viewer: await as(A, userId) } as never,
        { queries: 0 } as never
      ) as unknown as {
        query_data: {
          execute: (input: unknown, options: unknown) => Promise<unknown>;
        };
      };
      return (sql: string) =>
        tools.query_data.execute(
          { purpose: "audit probe", sql },
          { toolCallId: "t", messages: [] }
        );
    };

    beforeAll(async () => {
      process.env.DATABASE_URL = TEST_DATABASE_URL;
      ({ database } = await import("@repo/database"));
      reader = await import("@repo/database/reader");
      viewers = await import("../lib/library/viewer");
      aiAccess = await import("../lib/library/ai-access");
      facts = await import("../lib/facts/facts");
      for (const [user, role] of [
        ["u_owner", "admin"],
        ["u_admin", "admin"],
        ["u_eng", "planner"],
        ["u_op", "operator"],
        ["u_hr", "member"],
        ["u_fin", "member"],
      ]) {
        members.set(`${A}:${user}`, role);
      }
      members.set(`${B}:u_b`, "admin");
      await database.org.create({
        data: {
          id: A,
          name: "Audit facts",
          ownerUserId: "u_owner",
          libraryStage: "confidential",
        },
      });
      await database.org.create({
        data: {
          id: B,
          name: "Audit facts B",
          ownerUserId: "u_b",
          libraryStage: "confidential",
        },
      });
      await database.department.createMany({
        data: [
          { id: dept.hr, orgId: A, name: "Human Resources" },
          { id: dept.fin, orgId: A, name: "Finance" },
          { id: dept.eng, orgId: A, name: "Engineering" },
        ],
      });
      await database.departmentMember.createMany({
        data: [
          { orgId: A, departmentId: dept.hr, userId: "u_hr" },
          { orgId: A, departmentId: dept.fin, userId: "u_fin" },
          { orgId: A, departmentId: dept.eng, userId: "u_eng" },
        ],
      });
      await database.folder.createMany({
        data: [
          { id: folder.general, orgId: A, name: "General" },
          {
            id: folder.hr,
            orgId: A,
            name: "HR",
            confidential: true,
            inheritAccess: false,
            aiMode: "full",
          },
          {
            id: folder.fin,
            orgId: A,
            name: "Finance",
            confidential: true,
            inheritAccess: false,
            aiMode: "full",
          },
        ],
      });
      await database.accessGrant.createMany({
        data: [
          {
            orgId: A,
            folderId: folder.general,
            principalType: "everyone",
            principalId: "",
            capabilities: 7,
          },
          {
            orgId: A,
            folderId: folder.hr,
            principalType: "department",
            principalId: dept.hr,
            capabilities: 31,
          },
          {
            orgId: A,
            folderId: folder.fin,
            principalType: "department",
            principalId: dept.fin,
            capabilities: 31,
          },
        ],
      });
      doc.pub = await addDoc(A, "Public SOP", folder.general, "public text");
      doc.pub2 = await addDoc(A, "Public price list", folder.general, "77.25");
      doc.pub3 = await addDoc(A, "Public rates", folder.general, "rates");
      doc.pub4 = await addDoc(A, "Public terms", folder.general, "terms");
      doc.pub5 = await addDoc(A, "Public terms copy", folder.general, "terms");
      doc.hr = await addDoc(A, "Payroll HR", folder.hr, `Salary sheet ${HR}`);
      doc.fin = await addDoc(A, "Budget", folder.fin, `Supplier cost ${FIN}`);
      await addDoc(B, "B doc", null, "b text");
      rec.part = (
        await database.part.create({ data: { orgId: A, partNo: "P-AUD" } })
      ).id;
      rec.wc = (
        await database.workCenter.create({
          data: {
            orgId: A,
            name: "MILL-AUD",
            hourlyRate: 100,
            syncedAt: new Date(),
          } as never,
        })
      ).id;
      rec.mat = (
        await database.material.create({
          data: {
            orgId: A,
            name: "AL-AUD",
            unitCost: 5,
            syncedAt: new Date(),
          } as never,
        })
      ).id;
      rec.mat2 = (
        await database.material.create({
          data: { orgId: A, name: "SS-AUD", unitCost: 9 } as never,
        })
      ).id;
      rec.cust = (
        await database.customer.create({
          data: { orgId: A, name: "CUST-AUD", paymentTermDays: 30 } as never,
        })
      ).id;
      rec.routing = (
        await database.routing.create({
          data: {
            orgId: A,
            partId: rec.part,
            seq: 10,
            workCenterId: rec.wc,
            setupMin: 30,
            runMinPerUnit: 2,
            syncedAt: new Date(),
          } as never,
        })
      ).id;

      // Restricted facts from confidential documents (as the pipeline writes them).
      const hrSource = [{ id: doc.hr, quote: HR }];
      const finSource = [{ id: doc.fin, quote: FIN }];
      const approved = { status: "approved", reviewedAt: new Date() };
      fact.hrNote = await mkFact(
        { value: `note ${HR}`, evidence: `"${HR}" (Payroll HR)` },
        hrSource
      );
      fact.hrApproved = await mkFact(
        { value: `approved ${HR}`, evidence: `"${HR}"`, ...approved },
        hrSource
      );
      fact.finCost = await mkFact(
        {
          subjectType: "material",
          subjectId: rec.mat,
          subjectLabel: "AL-AUD",
          attribute: "unitCost",
          value: Number(FIN_VALUE),
          evidence: `"${FIN}" (Budget)`,
        },
        finSource
      );
      fact.finCustNote = await mkFact(
        {
          subjectType: "customer",
          subjectId: rec.cust,
          subjectLabel: "CUST-AUD",
          value: `cust ${FIN}`,
          evidence: `"${FIN}"`,
          ...approved,
        },
        finSource
      );
      fact.finRouting = await mkFact(
        {
          subjectType: "routing",
          subjectId: rec.routing,
          subjectLabel: "P-AUD op 10",
          attribute: "setupMin",
          value: 41,
          evidence: `"${FIN}"`,
          ...approved,
        },
        finSource
      );
      fact.hrSuperseded = await mkFact(
        {
          value: `superseded ${HR}`,
          evidence: `"${HR}"`,
          status: "superseded",
        },
        hrSource
      );
      fact.finRejected = await mkFact(
        { value: `rejected ${FIN}`, evidence: `"${FIN}"`, status: "rejected" },
        finSource
      );
      // Typed by a person: everyone in the shop sees it.
      fact.publicNote = await mkFact({
        value: "a public typed note",
        source: "manual",
        provenance: "none",
      });
      await database.fact.create({
        data: {
          orgId: B,
          number: 1,
          subjectType: "shop",
          subjectId: B,
          subjectLabel: "B",
          attribute: "note",
          value: ORG_B,
          provenance: "none",
          source: "manual",
        },
      });
    });

    afterAll(async () => {
      Reflect.deleteProperty(process.env, "ASK_SQL_ENABLED");
      await database?.org.deleteMany({ where: { id: { in: [A, B] } } });
    });

    describe("C1: Ask Takumo's SQL tool", () => {
      test("C1: off while ASK_SQL_ENABLED is unset (nothing reaches the database)", async () => {
        Reflect.deleteProperty(process.env, "ASK_SQL_ENABLED");
        await expect(
          reader.askQuery(database, A, "select fact_no, value from facts")
        ).rejects.toThrow(reader.ASK_SQL_OFF);
        const query = await dataTool("u_op");
        const out = await query("select fact_no, value from facts");
        expect(out).toMatchObject({ error: reader.ASK_SQL_OFF });
        expect(out).not.toHaveProperty("rows");
        for (const value of ["1", "TRUE", "yes", "true "]) {
          process.env.ASK_SQL_ENABLED = value;
          await expect(
            reader.askQuery(database, A, "select fact_no from facts")
          ).rejects.toThrow(reader.ASK_SQL_OFF);
        }
        Reflect.deleteProperty(process.env, "ASK_SQL_ENABLED");
      });

      describe("C1: switched on", () => {
        beforeAll(() => {
          process.env.ASK_SQL_ENABLED = "true";
        });
        afterAll(() => {
          Reflect.deleteProperty(process.env, "ASK_SQL_ENABLED");
        });

        test("C1: ask.facts shows only facts everyone may see, never another shop's", async () => {
          const all = await reader.askQuery(database, A, "select * from facts");
          // The typed fact proves queries really run.
          expect(all.rows.map((r) => r.value)).toContain("a public typed note");
          expect(markers(all.rows)).toEqual([]);
          expect(JSON.stringify(all.rows)).not.toContain(FIN_VALUE);
          const other = await reader.askQuery(
            database,
            A,
            `select * from facts where value = '${ORG_B}'`
          );
          expect(other.rows).toEqual([]);
        });

        test("C1: error probes on restricted fact values get a generic error with a reference", async () => {
          const query = await dataTool("u_op");
          const probes = [
            "select fact_no from facts where value::numeric > 0",
            "select fact_no from facts where subject_type = 'material' and value::numeric < 0 and (subject || ':' || value)::int > 0",
            "select fact_no from facts where status = 'superseded' and value::int > 0",
            "select fact_no from facts where value like 'cust%' and value::int > 0",
            "select fact_no from facts where subject = 'AL-AUD' and (subject || '=' || value)::int > 0",
            "select fact_no from facts where evidence::int > 0",
          ];
          let failed = 0;
          for (const sql of probes) {
            const text = JSON.stringify(await query(sql));
            expect(markers(text), sql).toEqual([]);
            expect(text, sql).not.toContain(FIN_VALUE);
            expect(text, sql).not.toContain("AL-AUD=");
            expect(text.match(RAW_POSTGRES)?.[0], sql).toBeUndefined();
            if (text.includes('"error"')) {
              failed += 1;
              expect(text, sql).toMatch(REF);
            }
          }
          // The typed note can't be cast either: the generic error is used.
          expect(failed).toBeGreaterThan(0);
        });

        test("C1: catalog and private-function probes are refused without detail", async () => {
          const probes = [
            "select count(*) from ask_private.company_facts()",
            "select * from ask_private.company_facts() limit 3",
            "select library.ai_source_ids('x', null, null, 'full')",
            "select * from pg_stat_activity",
            "select query from pg_stat_activity where usename = current_user",
            "select count(*) from pg_proc where prosrc ilike '%fact_access%'",
            `select U&"set\\005fconfig"('takumo.org_id', 'x', true)`,
            "select current_setting('takumo.org_sig')",
          ];
          for (const sql of probes) {
            const error = await reader.askQuery(database, A, sql).then(
              (result) => {
                throw new Error(
                  `ran: ${sql} => ${JSON.stringify(result.rows).slice(0, 200)}`
                );
              },
              (e: unknown) => e
            );
            expect(error, sql).toBeInstanceOf(reader.QueryError);
            const message = (error as Error).message;
            expect(markers(message), sql).toEqual([]);
            expect(message.match(RAW_POSTGRES)?.[0], sql).toBeUndefined();
          }
        });
      });
    });

    describe("M4: a guessed value never returns a hidden pending fact", () => {
      const hidden = async (value: number) => {
        const factId = await mkFact(
          {
            subjectType: "work_center",
            subjectId: rec.wc,
            subjectLabel: "MILL-AUD",
            attribute: "hourlyRate",
            value,
            evidence: `"${FIN}"`,
          },
          [{ id: doc.fin, quote: FIN }]
        );
        const row = await database.fact.findUniqueOrThrow({
          where: { id: factId },
          select: { number: true },
        });
        return { id: factId, number: row.number, label: `F-${row.number}` };
      };
      const finSourcesOf = (factId: string) =>
        database.factSource.findMany({
          where: { factId },
          select: { sourceId: true },
        });

      test("M4: proposeFact with the person's viewer makes a new fact", async () => {
        const secret = await hidden(137.5);
        const op = await as(A, "u_op");
        expect((await aiAccess.factAccess(op)).has(secret.id)).toBe(false);
        const made = await facts.proposeFact(A, {
          subject: { type: "work_center", id: rec.wc, label: "MILL-AUD" },
          attribute: "hourlyRate",
          value: 137.5,
          evidence: null,
          source: "manual",
          statedBy: "u_op",
          viewer: op,
        });
        expect(made.ok).toBe(true);
        if (!made.ok) {
          return;
        }
        expect(made.existing).toBe(false);
        expect(made.fact.id).not.toBe(secret.id);
        expect(made.fact.number).not.toBe(secret.number);
        expect(made.fact.label).not.toBe(secret.label);
        expect(await finSourcesOf(secret.id)).toEqual([{ sourceId: doc.fin }]);
      });

      test("M4: the Add fact form (addFact) doesn't return the hidden fact's number", async () => {
        const secret = await hidden(138.5);
        const { addFact } = await import(
          "../app/(authenticated)/knowledge/facts/actions"
        );
        signIn("u_op");
        const labels: string[] = [];
        for (const guess of ["138", "138.5", "139"]) {
          const result = await addFact({
            subjectType: "work_center",
            subjectId: rec.wc,
            attribute: "hourlyRate",
            value: guess,
            evidence: "",
          });
          expect(result.ok, guess).toBe(true);
          labels.push(result.ok ? result.label : "");
        }
        expect(labels).not.toContain(secret.label);
        expect(new Set(labels).size).toBe(3);
      });

      test("M4: a note with a guessed value doesn't return the hidden fact's number", async () => {
        const secret = await hidden(139.5);
        const { saveNote } = await import("../lib/facts/notes");
        h.noteFacts = [
          {
            subjectType: "work_center",
            partNo: null,
            rev: null,
            seq: null,
            name: "MILL-AUD",
            attribute: "hourlyRate",
            value: 139.5,
            quote: "the mill is 139.5 an hour",
          },
        ];
        const result = await saveNote(A, "u_op", {
          kind: "typed",
          text: "the mill is 139.5 an hour",
        });
        h.noteFacts = [];
        expect(result.skipped).toEqual([]);
        expect(result.proposed).toHaveLength(1);
        expect(result.proposed).not.toContain(secret.label);
      });

      test("M4: someone who may see the pending fact still joins it", async () => {
        const secret = await hidden(140.5);
        const made = await facts.proposeFact(A, {
          subject: { type: "work_center", id: rec.wc, label: "MILL-AUD" },
          attribute: "hourlyRate",
          value: 140.5,
          evidence: null,
          source: "manual",
          statedBy: "u_fin",
          viewer: await as(A, "u_fin"),
        });
        expect(made.ok && made.existing).toBe(true);
        expect(made.ok && made.fact.id).toBe(secret.id);
      });
    });
  }
);

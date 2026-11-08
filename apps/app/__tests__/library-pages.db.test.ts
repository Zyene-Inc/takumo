// @vitest-environment node
// The Company Knowledge Library's documents against a real database (phase
// 3): uploading into folders through the real upload route (same-name
// clashes explained, forged fields ignored), My Uploads and Recent, search
// (no AI), document details and versions, the Trash, retrying, RFQ and PO
// folders, and the pages themselves rendered to HTML. Storage and AI are
// stand-ins; nothing reaches Supabase or a provider. Runs only with
// TEST_DATABASE_URL.
import { randomUUID } from "node:crypto";
import { SidebarProvider } from "@repo/design-system/components/ui/sidebar";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

const h = await vi.hoisted(
  async () => await import("./fixtures/library-harness")
);
const ai = vi.hoisted(() => ({ embed: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../../../packages/database/node_modules/server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  usePathname: () => "/library",
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@repo/auth/server", () => ({
  auth: async () => h.state.session,
  shopRole: async () => null,
  listShopMembers: async () => [
    { userId: "user_planner", name: "Pat Planner" },
    { userId: "user_operator", name: "Olu Operator" },
  ],
}));
vi.mock("../lib/library/storage", async (original) => ({
  ...(await original<object>()),
  objectStore: () => h.state.store,
}));
vi.mock("../lib/knowledge/read", () => ({ readDocument: h.scriptedRead }));
vi.mock("../lib/knowledge/understand", async (original) => ({
  ...(await original<object>()),
  loadCatalog: async () => ({}),
  understandDocument: async (_org: string, name: string) => ({
    card: {
      docType: "sop",
      title: name,
      revision: "C",
      summary: `About ${name}.`,
      mentions: [],
    },
    linked: [],
    unmatched: [],
  }),
  contextualize: async (_org: string, _doc: unknown, chunks: string[]) =>
    chunks.map(() => ""),
}));
vi.mock("@repo/ai", async (original) => ({
  ...(await original<object>()),
  embedMany: (args: { values: string[] }) => h.scriptedEmbedMany(args),
  embed: (...args: unknown[]) => {
    ai.embed(...args);
    return h.scriptedEmbed();
  },
}));
vi.mock("@repo/ai/lib/models", async (original) => ({
  ...(await original<object>()),
  canEmbed: true,
  embeddingOptions: () => ({}),
}));
vi.mock("../lib/facts/notes", () => ({
  shopContext: async () => "",
  extractFacts: async () => h.state.facts,
}));
vi.mock("../lib/analytics", () => ({ track: vi.fn() }));
vi.mock("../lib/billing", () => ({ featureProblem: async () => null }));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

type Db = typeof import("@repo/database");

describe.skipIf(!TEST_DATABASE_URL)("library documents (database)", () => {
  let database: Db["database"];
  let upload: typeof import("../app/api/knowledge/upload/route");
  let browse: typeof import("../lib/library/browse");
  let detail: typeof import("../lib/library/detail");
  let format: typeof import("../lib/library/format");
  let search: typeof import("../lib/library/search");
  let virtual: typeof import("../lib/library/virtual");
  let viewers: typeof import("../lib/library/viewer");
  let actions: typeof import("../app/(authenticated)/library/actions");
  let knowledge: typeof import("../app/(authenticated)/knowledge/actions");
  let processing: typeof import("../lib/library/process");
  let orgId = "";
  let otherOrgId = "";

  const as = async (role: string, userId = `user_${role}`, org = orgId) => {
    h.state.session = { orgId: org, userId, role };
    const viewer = await viewers.resolveViewer();
    if (!viewer) {
      throw new Error("expected a viewer");
    }
    return viewer;
  };

  const send = (
    name: string,
    body: string,
    fields: Record<string, string> = {}
  ) =>
    upload.POST(
      h.uploadRequest(
        "http://test/api/knowledge/upload",
        name,
        h.text(body),
        fields
      )
    );

  /** Upload and wait for it to be read; returns the document's id. */
  const added = async (
    name: string,
    body: string,
    folderId?: string
  ): Promise<string> => {
    const response = await send(name, body, folderId ? { folderId } : {});
    const steps = await h.events(response);
    expect(steps.at(-1)?.type).toBe("done");
    const found = await database.source.findFirstOrThrow({
      where: {
        orgId: h.state.session.orgId ?? "",
        name: name.replace(/\.(txt|md|csv)$/, ""),
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    return found.id;
  };

  const folder = async (name: string) => {
    const result = await actions.createFolder(null, name);
    if (!result.ok) {
      throw new Error(result.error);
    }
    return result.id;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.SKIP_ENV_VALIDATION = "true";
    ({ database } = await import("@repo/database"));
    upload = await import("../app/api/knowledge/upload/route");
    browse = await import("../lib/library/browse");
    detail = await import("../lib/library/detail");
    format = await import("../lib/library/format");
    search = await import("../lib/library/search");
    virtual = await import("../lib/library/virtual");
    viewers = await import("../lib/library/viewer");
    actions = await import("../app/(authenticated)/library/actions");
    knowledge = await import("../app/(authenticated)/knowledge/actions");
    processing = await import("../lib/library/process");
  });

  beforeEach(async () => {
    h.resetState();
    ai.embed.mockClear();
    orgId = `org_pages_${randomUUID().slice(0, 8)}`;
    otherOrgId = `org_pages_other_${randomUUID().slice(0, 8)}`;
    for (const id of [orgId, otherOrgId]) {
      await database.org.create({
        data: {
          id,
          name: "Pages",
          ownerUserId: "user_owner",
          libraryStage: "library",
        },
      });
    }
    await as("planner");
  });

  afterAll(async () => {
    await database?.org.deleteMany({
      where: { id: { startsWith: "org_pages_" } },
    });
  });

  describe("uploading into folders", () => {
    test("documents go into the chosen folder; several at once", async () => {
      const sops = await folder("Work instructions");
      await as("operator");
      for (const name of ["Deburr.txt", "Torque.txt", "Coolant.txt"]) {
        await added(name, `${name} steps.`, sops);
      }
      const view = await browse.folderView(await as("operator"), sops);
      expect(view?.documents.map((d) => d.name)).toEqual([
        "Coolant",
        "Deburr",
        "Torque",
      ]);
      expect(view?.documents[0]).toMatchObject({
        state: "ready",
        uploadedBy: "user_operator",
        uploaderName: "Olu Operator",
        current: { number: 1, mimeType: "text/plain", originalKept: true },
      });
    });

    test("the same name in the same folder is refused, and says what can be done", async () => {
      const sops = await folder("SOPs here");
      const id = await added("Anodize.txt", "Anodize.", sops);
      const planner = await send("Anodize.txt", "Again.", { folderId: sops });
      expect(planner.status).toBe(409);
      expect(await planner.json()).toEqual({
        error:
          "There's already a document called Anodize. Rename your file and upload it again.",
        code: "name_taken",
        existing: { id, name: "Anodize", canAddVersion: true },
      });
      await as("operator");
      const operator = await send("Anodize.txt", "Again.", { folderId: sops });
      expect((await operator.json()).existing).toEqual({
        id,
        name: "Anodize",
        canAddVersion: false,
      });
      // The same name in another folder is a different document.
      await as("planner");
      const other = await folder("Elsewhere");
      await added("Anodize.txt", "Elsewhere.", other);
    });

    test("a folder from another shop (or a made-up one) is refused; the uploader can't be forged", async () => {
      await as("admin", "user_admin", otherOrgId);
      const theirs = await folder("Theirs");
      await as("operator");
      for (const folderId of [theirs, randomUUID(), "../x"]) {
        const response = await send("Sneaky.txt", "x", { folderId });
        expect(response.status).toBe(404);
      }
      expect(await database.source.count({ where: { orgId } })).toBe(0);
      const response = await send("Mine.txt", "x", {
        uploadedBy: "user_owner",
        orgId: otherOrgId,
      });
      expect((await h.events(response)).at(-1)?.type).toBe("done");
      expect(
        await database.source.findFirstOrThrow({
          where: { name: "Mine", orgId: { in: [orgId, otherOrgId] } },
          select: { orgId: true, uploadedBy: true },
        })
      ).toEqual({ orgId, uploadedBy: "user_operator" });
    });

    test("with the library off, uploads into a folder are refused (the Knowledge page still works)", async () => {
      const sops = await folder("Off folder");
      await database.org.update({
        where: { id: orgId },
        data: { libraryStage: "off" },
      });
      expect((await send("A.txt", "a", { folderId: sops })).status).toBe(404);
      expect((await h.events(await send("B.txt", "b"))).at(-1)?.type).toBe(
        "done"
      );
    });
  });

  describe("views, search and details", () => {
    test("My uploads lists only this person's documents; older ones say who's unknown", async () => {
      await added("Mine.txt", "Mine.");
      await as("operator");
      await added("Theirs.txt", "Theirs.");
      await database.source.create({
        data: { orgId, name: "Legacy", type: "upload", profile: "document" },
      });
      const planner = await as("planner");
      expect((await browse.myUploads(planner)).map((d) => d.name)).toEqual([
        "Mine",
      ]);
      const recent = await browse.recentDocuments(planner);
      expect(recent.map((d) => d.name)).toEqual(
        expect.arrayContaining(["Mine", "Theirs", "Legacy"])
      );
      expect(recent.find((d) => d.name === "Legacy")).toMatchObject({
        uploadedBy: null,
        uploaderName: "Not recorded",
      });
    });

    test("search finds names, folders, types and text; never the Trash, other shops or unfinished documents; no AI", async () => {
      const quality = await folder("Quality");
      const anodize = await added(
        "Anodize spec.txt",
        "Seal at 95 degrees.",
        quality
      );
      const trashed = await added("Old anodize.txt", "Old notes.");
      await knowledge.deleteDocument(trashed);
      await as("admin", "user_admin", otherOrgId);
      await added("Their anodize.txt", "Theirs.");
      const viewer = await as("planner");
      // A document still waiting to be read the first time.
      h.state.session = { orgId, userId: "user_planner", role: "planner" };
      const versions = await import("../lib/library/versions");
      await versions.createDocument(
        orgId,
        "user_planner",
        {
          name: "Anodize draft.txt",
          bytes: h.text("Draft."),
          mimeType: "text/plain",
        },
        "upload"
      );

      const byName = await search.searchLibrary(viewer, "anodize");
      expect(byName.map((r) => [r.document.name, r.matchedBy])).toEqual([
        ["Anodize spec", "name"],
      ]);
      const byFolder = await search.searchLibrary(viewer, "quality");
      expect(byFolder.map((r) => r.matchedBy)).toEqual(["folder"]);
      const byText = await search.searchLibrary(viewer, "degrees");
      expect(byText[0]).toMatchObject({ matchedBy: "text" });
      expect(byText[0].snippet).toContain("degrees");
      const byType = await search.searchLibrary(viewer, "sop");
      expect(byType.map((r) => r.document.id)).toContain(anodize);
      expect(await search.searchLibrary(viewer, "a")).toEqual([]);
      expect(ai.embed).not.toHaveBeenCalled();
    });

    test("details: versions, what Takumo read, activity in plain words", async () => {
      const id = await added("Reamer.txt", "Reamer speed 400 rpm.");
      h.state.embedFailures = 1;
      const versionResponse = await (
        await import("../app/api/library/documents/[sourceId]/versions/route")
      ).POST(
        h.uploadRequest(
          `http://test/api/library/documents/${id}/versions`,
          "Reamer v2.txt",
          h.text("Reamer speed 450 rpm.")
        ),
        { params: Promise.resolve({ sourceId: id }) }
      );
      expect((await h.events(versionResponse)).at(-1)?.type).toBe("error");
      const viewer = await as("planner");
      const page = await detail.documentDetail(viewer, id);
      expect(page?.versions.map((v) => [v.number, v.label])).toEqual([
        [2, "failed"],
        [1, "active"],
      ]);
      expect(page?.versions[0]).toMatchObject({
        canRetry: true,
        error: "Couldn't read that file just now.",
        uploaderName: "Pat Planner",
      });
      expect(page?.document).toMatchObject({
        state: "failed",
        stateIsNewVersion: true,
        current: { number: 1 },
      });
      expect(page?.classification).toBe("SOP, rev C");
      expect(page?.text?.content).toContain("400 rpm");
      expect(page?.text?.content).not.toContain("450");
      expect(page?.activity.map((a) => a.text)).toEqual(
        expect.arrayContaining([
          "Pat Planner uploaded it",
          "Pat Planner uploaded a new version (version 2)",
          "Takumo couldn't read a version (version 2)",
        ])
      );
      expect(JSON.stringify(page?.activity)).not.toContain("provider");
    });

    test("opening a document isn't activity; downloading it is", async () => {
      const id = await added("Torque chart.txt", "M6 bolts: 10 Nm.");
      const viewer = await as("planner");
      const download = await import("../lib/library/download");
      for (let i = 0; i < 3; i++) {
        expect(
          await download.fileLink(viewer, id, { download: false })
        ).toMatchObject({ ok: true });
      }
      expect(
        await download.fileLink(viewer, id, { download: true })
      ).toMatchObject({ ok: true });
      const page = await detail.documentDetail(viewer, id);
      const texts = page?.activity.map((a) => a.text) ?? [];
      expect(texts).toContain("Pat Planner downloaded it (version 1)");
      expect(texts.join("|")).not.toContain("opened it");
      // The audit log still has every opening.
      expect(
        await database.documentAuditLog.count({
          where: { orgId, sourceId: id, action: "preview" },
        })
      ).toBe(3);
    });

    test("an upload Takumo could never read stays on its uploader's My uploads", async () => {
      const operator = await as("operator");
      const response = await send("Blank scan.txt", "   ");
      expect((await h.events(response)).at(-1)?.type).toBe("error");
      const trashedByPerson = await added("Unwanted.txt", "Unwanted.");
      // Never read either (it will be retried), but a person trashed it.
      h.state.embedFailures = 1;
      const flaky = await send("Half read.txt", "Half.");
      expect((await h.events(flaky)).at(-1)?.type).toBe("error");
      const halfRead = await database.source.findFirstOrThrow({
        where: { orgId, name: { startsWith: "Half read" } },
      });
      expect(halfRead.currentVersionId).toBeNull();
      await as("planner");
      expect(await knowledge.deleteDocument(trashedByPerson)).toEqual({
        ok: true,
      });
      expect(await knowledge.deleteDocument(halfRead.id)).toEqual({
        ok: true,
      });
      const mine = await as("operator");
      expect(await browse.myUploads(mine)).toEqual([]);
      const unreadable = await browse.unreadableUploads(operator);
      expect(unreadable.map((d) => d.name)).toEqual(["Blank scan"]);
      expect(format.trashNote(unreadable[0])).toMatch(
        /^Moved to the Trash by Takumo on .+: it couldn't be read\.$/
      );
      // Not someone else's, and not ones a person put in the Trash.
      expect(await browse.unreadableUploads(await as("planner"))).toEqual([]);
      // Operators can't open the Trash, but can still open the document.
      expect(await browse.trashedDocuments(mine)).toEqual([]);
      expect(
        await detail.documentDetail(mine, unreadable[0].id)
      ).not.toBeNull();
    });

    test("retrying a failed version: its uploader or an editor, not other operators", async () => {
      await as("operator", "user_sam");
      h.state.embedFailures = 1;
      const response = await send("Flaky.txt", "Flaky.");
      expect((await h.events(response)).at(-1)?.type).toBe("error");
      const version = await database.documentVersion.findFirstOrThrow({
        where: { orgId },
      });
      await as("operator", "user_olu");
      expect(
        await knowledge.retryVersion(version.sourceId, version.id)
      ).toMatchObject({ ok: false });
      await as("operator", "user_sam");
      expect(
        await knowledge.retryVersion(version.sourceId, version.id)
      ).toEqual({
        ok: true,
      });
      expect((await processing.processVersion(version.id)).result).toBe("done");
    });

    test("documents from before originals were kept: no download, the text instead", async () => {
      const documents = await import("../lib/knowledge/documents");
      const legacy = await documents.storeDocument(
        orgId,
        "Old manual",
        "Old.",
        [{ content: "Old manual words.", heading: null, page: 1 }],
        { mayReplace: false }
      );
      const viewer = await as("operator");
      const page = await detail.documentDetail(viewer, legacy.sourceId);
      expect(page?.versions[0]).toMatchObject({
        label: "active",
        originalKept: false,
      });
      expect(page?.text?.content).toContain("Old manual words.");
      expect(page?.document.uploaderName).toBe("Not recorded");
    });

    test("reading an older document again uses its text (passages without a card marker)", async () => {
      const documents = await import("../lib/knowledge/documents");
      const ingest = await import("../lib/knowledge/ingest");
      const legacy = await documents.storeDocument(
        orgId,
        "Old setup",
        "Old.",
        [{ content: "Clamp at 30 Nm before op 20.", heading: null, page: 1 }],
        { mayReplace: false }
      );
      const steps: { type: string }[] = [];
      await ingest.rereadDocument(orgId, "user_planner", legacy.sourceId, (e) =>
        steps.push(e)
      );
      expect(steps.at(-1)?.type).toBe("done");
      const page = await detail.documentDetail(
        await as("planner"),
        legacy.sourceId
      );
      expect(page?.versions.map((v) => v.label)).toEqual([
        "active",
        "previous",
      ]);
      expect(page?.text?.content).toContain("Clamp at 30 Nm");
    });

    test("another shop's document has no page", async () => {
      await as("admin", "user_admin", otherOrgId);
      const theirs = await added("Theirs.txt", "Theirs.");
      const viewer = await as("admin");
      expect(await detail.documentDetail(viewer, theirs)).toBeNull();
    });
  });

  describe("Trash", () => {
    test("planners see and restore; operators see nothing; only admins delete for good", async () => {
      const id = await added("Old SOP.txt", "Old.");
      expect(await knowledge.deleteDocument(id)).toEqual({ ok: true });
      const planner = await as("planner");
      const [row] = await browse.trashedDocuments(planner);
      expect(row).toMatchObject({
        id,
        canDelete: true,
        canPurge: false,
        removerName: "Pat Planner",
      });
      expect(await browse.trashedDocuments(await as("operator"))).toEqual([]);
      expect(await knowledge.deleteDocument(id)).toMatchObject({ ok: false });
      await as("planner");
      expect(await knowledge.purgeDocument(id)).toMatchObject({ ok: false });
      const admin = await as("admin");
      expect((await browse.trashedDocuments(admin))[0]?.canPurge).toBe(true);
      // Storage can't delete the file yet: the page must not say it's gone.
      if (h.state.store) {
        h.state.store.fail.remove = true;
      }
      expect(await knowledge.purgeDocument(id)).toEqual({
        ok: true,
        complete: false,
      });
    });
  });

  describe("RFQs and purchase orders", () => {
    test("records with files from this shop only, linking to their own pages and files", async () => {
      const rfq = await database.rfq.create({
        data: {
          orgId,
          number: 7,
          source: "email",
          body: "x",
          subject: "Brackets",
        },
      });
      await database.rfqFile.create({
        data: {
          orgId,
          rfqId: rfq.id,
          name: "bracket.pdf",
          mediaType: "application/pdf",
          size: 10,
          sha256: "a",
          data: Buffer.from("x"),
        },
      });
      await database.rfq.create({
        data: { orgId, number: 8, source: "email", body: "no files" },
      });
      const theirs = await database.rfq.create({
        data: { orgId: otherOrgId, number: 1, source: "email", body: "x" },
      });
      await database.rfqFile.create({
        data: {
          orgId: otherOrgId,
          rfqId: theirs.id,
          name: "theirs.pdf",
          mediaType: "application/pdf",
          size: 10,
          sha256: "b",
          data: Buffer.from("x"),
        },
      });
      const viewer = await as("operator");
      const records = await virtual.rfqRecords(viewer);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        label: "RFQ-0007 · Brackets",
        href: `/quotes/${rfq.id}`,
      });
      expect(records[0].files[0].href).toMatch(
        new RegExp(`^/quotes/${rfq.id}/files/`)
      );
      expect(await virtual.poRecords(viewer)).toEqual([]);
    });
  });

  describe("pages", () => {
    // The app's layout puts every page inside the sidebar's provider.
    const render = async (load: () => Promise<unknown>) =>
      renderToStaticMarkup(
        createElement(SidebarProvider, null, (await load()) as ReactElement)
      );

    test("All files, a folder, a document, the Trash and search render for a member", async () => {
      const sops = await folder("Setup sheets");
      const id = await added("Lathe setup.txt", "Chuck pressure 20 bar.", sops);
      const home = await render(async () =>
        (await import("../app/(authenticated)/library/page")).default()
      );
      expect(home).toContain("All files");
      expect(home).toContain("Setup sheets");
      expect(home).toContain("General");
      const inFolder = await render(async () =>
        (
          await import("../app/(authenticated)/library/f/[folderId]/page")
        ).default({
          params: Promise.resolve({ folderId: sops }),
        })
      );
      expect(inFolder).toContain("Lathe setup");
      expect(inFolder).toContain(`href="/library/d/${id}"`);
      const page = await render(async () =>
        (
          await import("../app/(authenticated)/library/d/[sourceId]/page")
        ).default({
          params: Promise.resolve({ sourceId: id }),
        })
      );
      expect(page).toContain("Version 1");
      expect(page).toContain("Active");
      expect(page).toContain("Chuck pressure 20 bar.");
      const found = await render(async () =>
        (await import("../app/(authenticated)/library/search/page")).default({
          searchParams: Promise.resolve({ q: "chuck" }),
        })
      );
      expect(found).toContain("Lathe setup");
      const trash = await render(async () =>
        (await import("../app/(authenticated)/library/trash/page")).default()
      );
      expect(trash).toContain("The Trash is empty.");
    });

    test("pages are not found for another shop's ids, removed members, or shops without the library", async () => {
      await as("admin", "user_admin", otherOrgId);
      const theirs = await added("Theirs.txt", "Theirs.");
      await as("planner");
      await expect(
        render(async () =>
          (
            await import("../app/(authenticated)/library/d/[sourceId]/page")
          ).default({
            params: Promise.resolve({ sourceId: theirs }),
          })
        )
      ).rejects.toThrow("NEXT_NOT_FOUND");
      h.state.session = { orgId: null, userId: "user_gone", role: null };
      await expect(
        render(async () =>
          (await import("../app/(authenticated)/library/page")).default()
        )
      ).rejects.toThrow("NEXT_NOT_FOUND");
      await database.org.update({
        where: { id: orgId },
        data: { libraryStage: "off" },
      });
      await as("owner", "user_owner");
      await expect(
        render(async () =>
          (await import("../app/(authenticated)/library/page")).default()
        )
      ).rejects.toThrow("NEXT_NOT_FOUND");
    });
  });
});

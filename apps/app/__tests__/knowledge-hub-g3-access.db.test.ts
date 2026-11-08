// biome-ignore-all lint/suspicious/noBitwiseOperators: capability bit sets, as in lib/library/capabilities.ts.
// @vitest-environment node
// Gate G3 penetration tests (access control), written by an independent
// reviewer: each one is an exploit that failed while its hole was open
// (G3-F1 to G3-F7; F6 is a known limit, below). Restricted access is on
// (confidentialEnabled mocked as the other audit tests do).
// Needs TEST_DATABASE_URL.
import { randomUUID } from "node:crypto";
import { SidebarProvider } from "@repo/design-system/components/ui/sidebar";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.SKIP_ENV_VALIDATION = "true";

vi.mock("server-only", () => ({}));
vi.mock("../../../packages/database/node_modules/server-only", () => ({}));
vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../lib/analytics", () => ({ track: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  usePathname: () => "/onboarding",
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("../lib/library/handoff", () => ({ scheduleHandOff: vi.fn() }));

const members = new Map<string, string>();
const session: { orgId?: string; userId?: string } = {};
vi.mock("@repo/auth/server", () => ({
  auth: async () => {
    const role = members.get(`${session.orgId}:${session.userId}`) ?? null;
    return {
      userId: session.userId ?? null,
      orgId: role ? (session.orgId ?? null) : null,
      role,
    };
  },
  shopRole: async (userId: string, orgId: string) =>
    members.get(`${orgId}:${userId}`) ?? null,
  listShopMembers: async () => [],
}));
vi.mock("../lib/library/stage", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  confidentialEnabled: async () => true,
  restrictedAccessReady: () => true,
}));
const store = vi.hoisted(() => ({
  put: () => Promise.resolve(),
  get: () => Promise.resolve(new Uint8Array([1, 2, 3])),
  remove: () => Promise.resolve(),
  signedUrl: (key: string) => Promise.resolve(`https://storage.test/${key}`),
}));
vi.mock("../lib/library/storage", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  objectStore: () => store,
}));
// Client-only pieces of the onboarding page.
vi.mock("../app/(authenticated)/onboarding/import-wizard", () => ({
  ImportWizard: () => null,
}));
vi.mock("../app/(authenticated)/components/header", () => ({
  Header: () => null,
}));

type Db = typeof import("@repo/database");
type Viewer = import("../lib/library/viewer").Viewer;

const id = () => randomUUID();
const VIEW_DOWNLOAD = 3;
const CONTRIBUTOR = 7;
const EDITOR = 31;
const UPLOAD = 4;

const HR_DOC = "HR - termination list Q1";
const RECEIPT = "Salary review - Bob Jones";
const HIDDEN_PARENT = "Plant Closure 2027";

describe.skipIf(!TEST_DATABASE_URL)("G3 access-control pentest", () => {
  const orgId = `org_g3a_${id().slice(0, 8)}`;
  let database: Db["database"];
  let viewers: typeof import("../lib/library/viewer");
  const f = {
    hr: id(),
    receipts: id(),
    general: id(),
    closure: id(),
    closureSub: id(),
  };
  const d = {
    hrDoc: id(),
    receipt: id(),
    generalTwin: id(),
    closureDoc: id(),
  };
  const dept = { hr: id(), finance: id(), mgmt: id() };

  const as = async (userId: string): Promise<Viewer> => {
    const v = await viewers.viewerForMember(orgId, userId);
    if (!v) {
      throw new Error(`${userId} isn't a member`);
    }
    return v;
  };

  const addDoc = async (
    sourceId: string,
    name: string,
    folderId: string,
    uploadedBy = "u_hr"
  ) => {
    await database.source.create({
      data: {
        id: sourceId,
        orgId,
        name,
        type: "upload",
        profile: "document",
        folderId,
        uploadedBy,
        status: "ready",
        summary: `Summary of ${name}: confidential details inside.`,
      },
    });
    const versionId = id();
    await database.documentVersion.create({
      data: {
        id: versionId,
        orgId,
        sourceId,
        number: 1,
        name: `${name}.pdf`,
        status: "ready",
        originalKept: true,
        storageKey: `org/${orgId}/src/${sourceId}/v1-abc.pdf`,
        mimeType: "application/pdf",
        size: 3,
        uploadedBy,
      },
    });
    await database.source.update({
      where: { id: sourceId },
      data: { currentVersionId: versionId, versionSeq: 1 },
    });
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    ({ database } = await import("@repo/database"));
    viewers = await import("../lib/library/viewer");
    members.set(`${orgId}:u_owner`, "admin");
    members.set(`${orgId}:u_admin`, "admin");
    members.set(`${orgId}:u_hr`, "operator");
    members.set(`${orgId}:u_fin`, "operator");
    members.set(`${orgId}:u_op`, "operator");
    await database.org.create({
      data: {
        id: orgId,
        name: "G3A",
        ownerUserId: "u_owner",
        libraryStage: "confidential",
      },
    });
    await database.department.createMany({
      data: [
        { id: dept.hr, orgId, name: "Human Resources" },
        { id: dept.finance, orgId, name: "Finance" },
        { id: dept.mgmt, orgId, name: "Management" },
      ],
    });
    await database.departmentMember.createMany({
      data: [
        { orgId, departmentId: dept.hr, userId: "u_hr" },
        { orgId, departmentId: dept.finance, userId: "u_fin" },
      ],
    });
    await database.folder.createMany({
      data: [
        {
          id: f.hr,
          orgId,
          name: "HR",
          kind: "system",
          systemKey: "hr",
          confidential: true,
          inheritAccess: false,
          aiMode: "off",
        },
        {
          id: f.receipts,
          orgId,
          name: "Receipts",
          kind: "system",
          systemKey: "receipts",
          confidential: true,
          inheritAccess: false,
          aiMode: "off",
        },
        { id: f.general, orgId, name: "General" },
        { id: f.closure, orgId, name: HIDDEN_PARENT },
      ],
    });
    await database.folder.create({
      data: {
        id: f.closureSub,
        orgId,
        name: "Shared drawings",
        parentId: f.closure,
      },
    });
    await database.accessGrant.createMany({
      data: [
        {
          orgId,
          folderId: f.hr,
          principalType: "department",
          principalId: dept.hr,
          capabilities: EDITOR,
        },
        {
          orgId,
          folderId: f.receipts,
          principalType: "department",
          principalId: dept.finance,
          capabilities: EDITOR,
        },
        {
          orgId,
          folderId: f.receipts,
          principalType: "everyone",
          principalId: "",
          capabilities: UPLOAD,
        },
        {
          orgId,
          folderId: f.general,
          principalType: "everyone",
          principalId: "",
          capabilities: CONTRIBUTOR,
        },
        // Plant Closure: Management only.
        {
          orgId,
          folderId: f.closure,
          principalType: "department",
          principalId: dept.mgmt,
          capabilities: EDITOR,
        },
        // One operator is given its "Shared drawings" subfolder.
        {
          orgId,
          folderId: f.closureSub,
          principalType: "user",
          principalId: "u_op",
          capabilities: VIEW_DOWNLOAD,
        },
      ],
    });
    await addDoc(d.hrDoc, HR_DOC, f.hr, "u_hr");
    // Finance uploads with the plain name (they can see Receipts).
    await addDoc(d.receipt, RECEIPT, f.receipts, "u_fin");
    // A document the operator was given, in a folder they can't see.
    await addDoc(d.closureDoc, "closure-shared-plan", f.closure, "u_owner");
    await database.accessGrant.create({
      data: {
        orgId,
        sourceId: d.closureDoc,
        principalType: "user",
        principalId: "u_op",
        capabilities: VIEW_DOWNLOAD,
      },
    });
  });

  afterAll(async () => {
    await database?.org.deleteMany({ where: { id: orgId } });
  });

  // F1 -------------------------------------------------------------------
  test("F1: the owner on record demoted to a lesser role keeps owner powers in SQL (L3 only fixed in TS)", async () => {
    const { accessTo } = await import("../lib/library/access");
    const { fileLink } = await import("../lib/library/download");
    const { grantAccess } = await import("../lib/library/grants");
    members.set(`${orgId}:u_owner`, "member");
    try {
      const demoted = await as("u_owner");
      expect(demoted.isOwner).toBe(false);
      expect(demoted.isAdmin).toBe(false);
      // A "member" in no department has no business in HR...
      const hr = await accessTo(demoted, { sourceId: d.hrDoc });
      expect.soft(hr?.capabilities ?? 0).toBe(0);
      // ...nor can download its file...
      const link = await fileLink(demoted, d.hrDoc, { download: true });
      expect.soft(link.ok).toBe(false);
      // ...nor hand out "manage" on HR.
      const granted = await grantAccess(
        demoted,
        { folderId: f.hr },
        { type: "user", id: "u_op" },
        63
      );
      expect.soft(granted.ok).toBe(false);
    } finally {
      members.set(`${orgId}:u_owner`, "admin");
      await database.accessGrant.deleteMany({
        where: {
          orgId,
          folderId: f.hr,
          principalType: "user",
          principalId: "u_op",
        },
      });
    }
  });

  // F2 -------------------------------------------------------------------
  test("F2: /onboarding lists the newest uploads, confidential ones included, with their summaries", async () => {
    Object.assign(session, { orgId, userId: "u_op" });
    const { default: OnboardingPage } = await import(
      "../app/(authenticated)/onboarding/page"
    );
    const html = renderToStaticMarkup(
      createElement(
        SidebarProvider,
        null,
        (await OnboardingPage({
          searchParams: Promise.resolve({}),
        })) as ReactElement
      )
    );
    expect(html).not.toContain(HR_DOC);
    expect(html).not.toContain(RECEIPT);
  });

  // F3 -------------------------------------------------------------------
  test("F3: moving a document into a drop box reveals whether a hidden document has that name", async () => {
    const { moveDocument } = await import("../lib/library/folders");
    const admin = await as("u_admin");
    // The admin adds a document named as the guess in General (they can),
    // then tries to move it into Receipts, where they may only upload.
    await addDoc(d.generalTwin, RECEIPT, f.general, "u_admin");
    const result = await moveDocument(admin, d.generalTwin, f.receipts);
    // A wrong guess is moved (ok); a right guess must look the same.
    const said = result.ok ? "" : result.error;
    expect(said).not.toContain("already a document");
  });

  // F4 -------------------------------------------------------------------
  test("F4: a document's page names the hidden folders above it", async () => {
    const { documentDetail } = await import("../lib/library/detail");
    const op = await as("u_op");
    const detail = await documentDetail(op, d.closureDoc);
    expect(detail).not.toBeNull();
    expect(JSON.stringify(detail?.trail)).not.toContain(HIDDEN_PARENT);
    expect(JSON.stringify(detail?.document.folder)).not.toContain(
      HIDDEN_PARENT
    );
  });

  // F5 -------------------------------------------------------------------
  test("F5: the access dialog of a shared subfolder names the hidden folder above and its grantees", async () => {
    const { accessView } = await import("../lib/library/access-view");
    const op = await as("u_op");
    const view = await accessView(op, { folderId: f.closureSub });
    expect(view).not.toBeNull();
    // Who can open this subfolder is shown (it's the viewer's to see), but
    // not the name of the hidden folder they get it from.
    const text = JSON.stringify(view?.entries);
    expect(text).not.toContain(HIDDEN_PARENT);
    expect(text).toContain("a folder above");
  });

  // F6 -------------------------------------------------------------------
  // Known limit, not fixed: names are unique among top-level folders, so any
  // refusal says a hidden one has that exact name (the same holds for a
  // document's name in a folder the person can open). Closing it would mean
  // allowing duplicate names; it needs the exact name guessed.
  test("F6 (known limit): creating a top-level folder tells whether a hidden one has that name", async () => {
    const { createFolder } = await import("../lib/library/folders");
    members.set(`${orgId}:u_plan`, "planner");
    const planner = await as("u_plan");
    const { folderCapabilities } = await import("../lib/library/access");
    expect(((await folderCapabilities(planner)).get(f.closure) ?? 0) & 1).toBe(
      0
    );
    const result = await createFolder(planner, null, HIDDEN_PARENT);
    const said = result.ok ? "" : result.error;
    expect(said).toContain("already a folder");
  });

  // F7 -------------------------------------------------------------------
  test("F7: a confidential folder that inherits, moved under another confidential folder, opens to that folder's people", async () => {
    const { setInheritance } = await import("../lib/library/grants");
    const { moveFolder } = await import("../lib/library/folders");
    const { accessTo } = await import("../lib/library/access");
    const legal = id();
    const payroll = id();
    const legalDoc = id();
    const legalTeam = id();
    members.set(`${orgId}:u_legal_mgr`, "operator");
    members.set(`${orgId}:u_both`, "operator");
    await database.department.create({
      data: { id: legalTeam, orgId, name: "Legal" },
    });
    await database.departmentMember.create({
      data: { orgId, departmentId: legalTeam, userId: "u_legal_mgr" },
    });
    // Two confidential folders the owner made (normal kind, so movable).
    await database.folder.createMany({
      data: [
        {
          id: legal,
          orgId,
          name: "Legal",
          confidential: true,
          inheritAccess: false,
        },
        {
          id: payroll,
          orgId,
          name: "Payroll",
          confidential: true,
          inheritAccess: false,
        },
      ],
    });
    await database.accessGrant.createMany({
      data: [
        {
          orgId,
          folderId: legal,
          principalType: "department",
          principalId: legalTeam,
          capabilities: 63,
        },
        {
          orgId,
          folderId: legal,
          principalType: "user",
          principalId: "u_both",
          capabilities: EDITOR,
        },
        {
          orgId,
          folderId: payroll,
          principalType: "department",
          principalId: dept.finance,
          capabilities: EDITOR,
        },
        {
          orgId,
          folderId: payroll,
          principalType: "user",
          principalId: "u_both",
          capabilities: EDITOR,
        },
      ],
    });
    await addDoc(legalDoc, "Legal - pending lawsuit", legal, "u_legal_mgr");
    const fin = await as("u_fin");
    expect(
      ((await accessTo(fin, { sourceId: legalDoc }))?.capabilities ?? 0) & 1
    ).toBe(0);
    // 1. Legal's manager switches "inherit" on: Takumo says nobody gains
    //    (a confidential folder inherits nothing), so no confirmation.
    const inherit = await setInheritance(
      await as("u_legal_mgr"),
      { folderId: legal },
      true
    );
    expect(inherit).toEqual({ ok: true });
    // 2. Someone who can only edit both folders (no "manage") moves Legal
    //    into Payroll. Moves of a confidential folder never change access...
    const moved = await moveFolder(await as("u_both"), legal, payroll);
    expect(moved).toEqual({ ok: true });
    // ...yet Finance (Payroll's department) can now open Legal's documents.
    expect(
      ((await accessTo(fin, { sourceId: legalDoc }))?.capabilities ?? 0) & 1
    ).toBe(0);
  });
});

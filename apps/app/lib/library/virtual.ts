import "server-only";

import { database } from "@repo/database";
import { poLabel } from "../orders/types";
import { rfqLabel } from "../quotes/types";
import { trustedViewer, type Viewer } from "./viewer";

// RFQs and Purchase Orders in the library: read-only "virtual folders" over
// the files that came with each RFQ and customer PO. Nothing is copied: each
// entry links to the RFQ or PO itself and to the file routes those pages
// already use. Who may see them is the same as on those pages today: every
// active member of the shop (the viewer exists only for one).

export interface VirtualFile {
  href: string;
  id: string;
  mediaType: string;
  name: string;
  size: number;
}

export interface VirtualRecord {
  files: VirtualFile[];
  href: string;
  id: string;
  label: string;
  party: string | null;
  receivedAt: Date;
  status: string;
}

const LIMIT = 100;

/** RFQs that came with files, newest first. */
export const rfqRecords = async (viewer: Viewer): Promise<VirtualRecord[]> => {
  const { orgId } = trustedViewer(viewer);
  const rfqs = await database.rfq.findMany({
    where: { orgId, files: { some: {} } },
    orderBy: { receivedAt: "desc" },
    take: LIMIT,
    select: {
      id: true,
      number: true,
      customerName: true,
      subject: true,
      status: true,
      receivedAt: true,
      files: {
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, mediaType: true, size: true },
      },
    },
  });
  return rfqs.map((r) => ({
    id: r.id,
    label: `${rfqLabel(r.number)}${r.subject ? ` · ${r.subject}` : ""}`,
    party: r.customerName,
    status: r.status,
    receivedAt: r.receivedAt,
    href: `/quotes/${r.id}`,
    files: r.files.map((f) => ({
      ...f,
      href: `/quotes/${r.id}/files/${f.id}`,
    })),
  }));
};

/** Customer POs that came with files, newest first. */
export const poRecords = async (viewer: Viewer): Promise<VirtualRecord[]> => {
  const { orgId } = trustedViewer(viewer);
  const pos = await database.customerPo.findMany({
    where: { orgId, files: { some: {} } },
    orderBy: { receivedAt: "desc" },
    take: LIMIT,
    select: {
      id: true,
      number: true,
      poNo: true,
      customerName: true,
      status: true,
      receivedAt: true,
      files: {
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, mediaType: true, size: true },
      },
    },
  });
  return pos.map((p) => ({
    id: p.id,
    label: `${poLabel(p.number)}${p.poNo ? ` · ${p.poNo}` : ""}`,
    party: p.customerName,
    status: p.status,
    receivedAt: p.receivedAt,
    href: `/orders/incoming/${p.id}`,
    files: p.files.map((f) => ({
      ...f,
      href: `/orders/incoming/${p.id}/files/${f.id}`,
    })),
  }));
};

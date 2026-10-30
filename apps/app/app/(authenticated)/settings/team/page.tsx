import { listShopInvitations, listShopMembers } from "@repo/auth/server";
import { Badge } from "@repo/design-system/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@repo/design-system/components/ui/table";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getAccess } from "@/lib/access";
import { getBilling } from "@/lib/billing";
import { Header } from "../../components/header";
import { InviteForm, RevokeButton } from "./invite-form";
import { ROLE_HELP } from "./roles";

export const metadata: Metadata = { title: "Team · Takumo" };

const TeamPage = async () => {
  const { orgId, canManageBilling } = await getAccess();
  if (!orgId) {
    notFound();
  }
  const [members, invitations, { entitlements }] = await Promise.all([
    listShopMembers(orgId),
    listShopInvitations(orgId),
    getBilling(orgId),
  ]);
  const used = members.length + invitations.length;
  const full = entitlements.seats !== null && used >= entitlements.seats;

  return (
    <>
      <Header page="Team" pages={["Settings"]} />
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <p className="text-muted-foreground text-sm">
          {used} {used === 1 ? "person" : "people"}
          {entitlements.seats === null
            ? ` · unlimited users on ${entitlements.plan.name}`
            : ` of ${entitlements.seats} on the ${entitlements.plan.name} plan`}
          {full && (
            <>
              {" · "}
              <Link className="underline" href="/settings/billing">
                Upgrade to Pro
              </Link>{" "}
              to add more.
            </>
          )}
        </p>
        {canManageBilling && !full && <InviteForm />}
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="font-medium">{m.name}</TableCell>
                  <TableCell>{m.email}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{m.role}</Badge>{" "}
                    <span className="text-muted-foreground text-xs">
                      {ROLE_HELP[m.role] ?? ""}
                    </span>
                  </TableCell>
                  <TableCell />
                </TableRow>
              ))}
              {invitations.map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="text-muted-foreground">
                    Invited
                  </TableCell>
                  <TableCell>{i.email}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    Expires {i.expiresAt.slice(0, 10)}
                  </TableCell>
                  <TableCell>
                    {canManageBilling && (
                      <RevokeButton email={i.email} id={i.id} />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <p className="text-muted-foreground text-xs">
          Roles are managed in WorkOS. To change someone's role, ask Takumo
          support or use the WorkOS dashboard.
        </p>
      </div>
    </>
  );
};

export default TeamPage;

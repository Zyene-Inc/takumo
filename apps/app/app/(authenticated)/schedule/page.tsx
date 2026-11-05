import { database, forOrg } from "@repo/database";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { CalendarDaysIcon, GaugeIcon, HelpCircleIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getAccess } from "@/lib/access";
import { byOperation, crewText } from "@/lib/schedule/crew";
import { hashFingerprint, latestPlan, loadShop } from "@/lib/schedule/plan";
import { type ShortStaffed, shortStaffed } from "@/lib/schedule/staffing";
import { Header } from "../components/header";
import { EmptyState } from "../shop/components/format";
import { Board, type OrderInfo } from "./board";
import { ReplanButton } from "./replan-button";

export const metadata: Metadata = { title: "Schedule · Takumo" };
// Re-planning waits on the engine.
export const maxDuration = 60;

const STATUS_LABEL: Record<string, { label: string; hint: string }> = {
  OPTIMAL: {
    label: "Best possible plan",
    hint: "The solver proved no plan has fewer late days.",
  },
  FEASIBLE: {
    label: "Optimised plan",
    hint: "The solver improved the plan until it stopped finding better ones.",
  },
  HEURISTIC: {
    label: "Quick plan",
    hint: "Too many operations to optimise in seconds; this plan follows due dates and priorities.",
  },
};

const ago = (date: Date) => {
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
};

/** Machine-days short of qualified people, and roster notices (F3.1-R5). */
const PeopleAlert = ({
  staffing,
  notices,
}: {
  notices: string[];
  staffing: ShortStaffed[];
}) =>
  staffing.length === 0 && notices.length === 0 ? null : (
    <Alert>
      <AlertTitle>People</AlertTitle>
      <AlertDescription>
        <ul className="list-disc pl-4">
          {staffing.map((s) => (
            <li key={s.machine}>
              {s.machine} has fewer qualified people than hours on{" "}
              {s.days.join(", ")}
              {s.more ? ` and ${s.more} more days` : ""}; it's planned only for
              the hours someone is in.
            </li>
          ))}
          {notices.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
        <Link className="underline" href="/shop/operators">
          See who runs what
        </Link>
        .
      </AlertDescription>
    </Alert>
  );

const SchedulePage = async () => {
  const { orgId, canEditShop } = await getAccess();
  if (!orgId) {
    notFound();
  }

  const plan = await latestPlan(orgId);
  // Machine-days the plan could only partly staff (F3.1-R5).
  const staffing = plan
    ? shortStaffed(plan.output.load, new Date().toISOString().slice(0, 10))
    : [];
  const db = forOrg(database, orgId);
  const openOrders = await db.order.count({
    where: { status: { in: ["open", "in_progress"] } },
  });

  const toolbar = (
    <div className="flex items-center gap-2 px-4">
      <Button asChild size="sm" variant="ghost">
        <Link href="/schedule/calendar">
          <CalendarDaysIcon /> Calendar
        </Link>
      </Button>
      <Button asChild size="sm" variant="ghost">
        <Link href="/schedule/bottlenecks">
          <GaugeIcon /> Bottlenecks
        </Link>
      </Button>
      <Button asChild size="sm" variant="outline">
        <Link href="/schedule/check">
          <HelpCircleIcon /> Can we take this order?
        </Link>
      </Button>
    </div>
  );

  if (!plan) {
    return (
      <>
        <Header page="Board" pages={["Schedule"]}>
          {toolbar}
        </Header>
        <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
          {openOrders === 0 ? (
            <EmptyState>
              No open orders to schedule yet.{" "}
              <Link className="underline" href="/onboarding?type=orders">
                Upload your open orders
              </Link>{" "}
              and routings first.
            </EmptyState>
          ) : (
            <EmptyState>
              <p>
                {openOrders} open order{openOrders === 1 ? "" : "s"} and no plan
                yet.
              </p>
              {canEditShop ? (
                <div className="mt-4 flex justify-center">
                  <ReplanButton label="Build the plan" />
                </div>
              ) : (
                <p className="mt-2">Ask a planner to build the first plan.</p>
              )}
            </EmptyState>
          )}
        </div>
      </>
    );
  }

  // Has anything the plan depends on changed since it was made? (Whether it's
  // from an earlier day is checked in the browser, which knows the local date.)
  const current = await loadShop(orgId, plan.input.request.start_date);
  const stale = hashFingerprint(current.request) !== plan.input.fingerprint;

  const orderNos = plan.output.orders.map((o) => o.order_no);
  const orders = await db.order.findMany({
    where: { orderNo: { in: orderNos } },
    select: {
      id: true,
      orderNo: true,
      qty: true,
      part: { select: { partNo: true } },
      customer: { select: { name: true } },
    },
  });
  const orderInfo: Record<string, OrderInfo> = Object.fromEntries(
    orders.map((o) => [
      o.orderNo,
      {
        id: o.id,
        qty: o.qty,
        partNo: o.part.partNo,
        customer: o.customer?.name ?? null,
      },
    ])
  );
  const status = STATUS_LABEL[plan.output.status];

  return (
    <>
      <Header page="Board" pages={["Schedule"]}>
        {toolbar}
      </Header>
      <div className="flex min-w-0 flex-1 flex-col gap-4 p-4 pt-0">
        <p className="text-muted-foreground text-sm">
          Planned {ago(plan.createdAt)} from{" "}
          {new Date(
            `${plan.input.request.start_date}T00:00:00Z`
          ).toLocaleDateString("en-US", {
            timeZone: "UTC",
            weekday: "long",
            month: "short",
            day: "numeric",
          })}
          .{" "}
          {status && (
            <Badge title={status.hint} variant="outline">
              {status.label}
            </Badge>
          )}
        </p>

        {stale && (
          <Alert>
            <AlertTitle>This plan is out of date</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-3">
              Orders, routings, machines or the calendar changed since it was
              made.
              {canEditShop ? (
                <ReplanButton label="Re-plan now" size="sm" />
              ) : (
                " Ask a planner to re-plan."
              )}
            </AlertDescription>
          </Alert>
        )}

        {plan.input.skipped.length > 0 && (
          <Alert>
            <AlertTitle>
              {plan.input.skipped.length} open order
              {plan.input.skipped.length === 1 ? " isn't" : "s aren't"} on the
              board
            </AlertTitle>
            <AlertDescription>
              <p>
                {plan.input.skipped
                  .slice(0, 8)
                  .map((s) => `${s.orderNo} (${s.reason})`)
                  .join(", ")}
                {plan.input.skipped.length > 8 ? ", …" : ""}.{" "}
                <Link className="underline" href="/shop/parts">
                  Add routings
                </Link>{" "}
                so Takumo can schedule them.
              </p>
            </AlertDescription>
          </Alert>
        )}

        <PeopleAlert notices={plan.output.notices ?? []} staffing={staffing} />

        {plan.input.assumptions.length > 0 && (
          <Alert>
            <AlertTitle>Assumptions</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {plan.input.assumptions.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
              <Link className="underline" href="/shop/work-centers">
                Fix them on the machines page
              </Link>
              .
            </AlertDescription>
          </Alert>
        )}

        <Board
          canEdit={canEditShop}
          crews={Object.fromEntries(
            [...byOperation(plan.output.assignments ?? [])].map(
              ([key, list]) => [key, crewText(list)]
            )
          )}
          operations={plan.output.operations}
          orderInfo={orderInfo}
          orders={plan.output.orders}
          request={plan.input.request}
        />
      </div>
    </>
  );
};

export default SchedulePage;

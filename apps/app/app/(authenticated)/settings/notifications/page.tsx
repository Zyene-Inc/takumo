import { auth } from "@repo/auth/server";
import { database } from "@repo/database";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  ALERT_TITLE,
  ALERT_TYPES,
  type AlertType,
  alertTypesFor,
} from "@/lib/alerts/detect";
import {
  SECTION_HINT,
  SECTION_TITLE,
  SECTIONS,
  type SectionKey,
  sectionsFor,
} from "@/lib/brief/content";
import { DEFAULT_TIMING } from "@/lib/brief/timing";
import { linkSecret } from "@/lib/brief/urls";
import { Header } from "../../components/header";
import { NotificationsForm } from "./form";

export const metadata: Metadata = { title: "Notifications · Takumo" };

const NotificationsPage = async () => {
  const { orgId, userId, role } = await auth();
  if (!(orgId && userId)) {
    notFound();
  }
  const prefs = await database.notifyPrefs.findUnique({
    where: { orgId_userId: { orgId, userId } },
  });
  const sections = sectionsFor(role).map((key) => ({
    key,
    title: SECTION_TITLE[key],
    hint: SECTION_HINT[key],
  }));
  const alerts = alertTypesFor(role).map((key) => ({
    key,
    title: ALERT_TITLE[key],
  }));
  return (
    <>
      <Header page="Notifications" pages={["Settings"]} />
      <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
        <p className="max-w-3xl text-muted-foreground text-sm">
          Your morning brief and alerts, by email. These settings are yours
          only; everyone in the shop chooses their own.
          {!linkSecret() &&
            " Approve and won/lost buttons in emails are off until your Takumo admin sets them up; the links open the app instead."}
        </p>
        <NotificationsForm
          alerts={alerts}
          initial={{
            briefOn: prefs?.briefOn ?? DEFAULT_TIMING.briefOn,
            briefTime: prefs?.briefTime ?? DEFAULT_TIMING.briefTime,
            timeZone: prefs?.timeZone ?? DEFAULT_TIMING.timeZone,
            briefOff: (prefs?.briefOff ?? []).filter((k): k is SectionKey =>
              (SECTIONS as readonly string[]).includes(k)
            ),
            alertsOff: (prefs?.alertsOff ?? []).filter((k): k is AlertType =>
              (ALERT_TYPES as readonly string[]).includes(k)
            ),
          }}
          sections={sections}
        />
      </div>
    </>
  );
};

export default NotificationsPage;

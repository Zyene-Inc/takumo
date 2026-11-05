import { auth, listShopMembers } from "@repo/auth/server";
import { database, forOrg } from "@repo/database";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAccess } from "@/lib/access";
import { phoneConfigured, shopNumbers } from "@/lib/phone/client";
import { displayPhone } from "@/lib/phone/twilio";
import { Header } from "../../../components/header";
import { type PhoneView, Phones } from "./phones";

export const metadata: Metadata = { title: "Notes by text · Takumo" };

const PhoneSettingsPage = async () => {
  const { orgId, canManageConnectors } = await getAccess();
  const { userId } = await auth();
  if (!(orgId && userId)) {
    notFound();
  }
  const db = forOrg(database, orgId);
  const [phones, operators, members] = await Promise.all([
    db.phoneNumber.findMany({ orderBy: [{ name: "asc" }] }),
    canManageConnectors
      ? db.operator.findMany({
          where: { active: true },
          orderBy: { name: "asc" },
          select: { id: true, name: true },
        })
      : [],
    canManageConnectors ? listShopMembers(orgId) : [],
  ]);
  const configured = phoneConfigured();
  const numbers = shopNumbers();
  const views: PhoneView[] = phones
    .filter((p) => canManageConnectors || p.userId === userId)
    .map((p) => ({
      id: p.id,
      name: p.name,
      phone: displayPhone(p.phone),
      confirmed: p.verifiedAt !== null,
      codeSent: p.codeSentAt !== null,
    }));

  return (
    <>
      <Header
        page="Notes by text"
        pages={["Settings", "Integrations"]}
      />
      <div className="flex max-w-3xl flex-1 flex-col gap-4 p-4 pt-0">
        <p className="text-muted-foreground text-sm">
          Operators can send a voice note or a text from their phone, by SMS
          or WhatsApp, instead of opening Takumo. Each one becomes a note on
          Knowledge → Voice notes, read for facts like one left in the app,
          and Takumo texts back what it found for a supervisor to review.
          Only phones registered and confirmed here are listened to; messages
          from any other number are ignored and not kept.
        </p>
        {configured ? (
          <div className="grid gap-1 rounded-lg border px-3 py-3 text-sm">
            <p className="font-medium">Your shop's number</p>
            {numbers.sms && <p>Text: {displayPhone(numbers.sms)}</p>}
            {numbers.whatsapp && (
              <p>WhatsApp: {displayPhone(numbers.whatsapp)}</p>
            )}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed px-3 py-3 text-muted-foreground text-sm">
            {canManageConnectors
              ? "Text notes aren't set up on this Takumo yet: it needs a phone number to text (Twilio). Ask Takumo support to turn it on."
              : "Text notes aren't set up for your shop yet. Ask your admin."}
          </p>
        )}
        <Phones
          canManage={canManageConnectors}
          configured={configured}
          members={members.map((m) => ({ userId: m.userId, name: m.name }))}
          operators={operators}
          phones={views}
        />
      </div>
    </>
  );
};

export default PhoneSettingsPage;

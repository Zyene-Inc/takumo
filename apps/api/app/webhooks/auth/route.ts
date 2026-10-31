import { analytics } from "@repo/analytics/server";
import { getWorkOS, type WebhookEvent } from "@repo/auth/server";
import { database } from "@repo/database";
import { log } from "@repo/observability/log";
import { trialEndsAt } from "@repo/payments/plans";
import { NextResponse } from "next/server";
import { env } from "@/env";

// WorkOS → Takumo: keeps Org/Member rows and analytics in sync.
// Configure in the WorkOS dashboard → Webhooks with this URL:
//   https://<api-host>/webhooks/auth
// Events: user.*, organization.*, organization_membership.*

const handleEvent = async (event: WebhookEvent) => {
  switch (event.event) {
    case "user.created":
    case "user.updated": {
      const user = event.data;
      analytics?.identify({
        distinctId: user.id,
        properties: {
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          avatar: user.profilePictureUrl,
          createdAt: new Date(user.createdAt),
        },
      });
      analytics?.capture({
        event: event.event === "user.created" ? "User Created" : "User Updated",
        distinctId: user.id,
      });
      break;
    }
    case "user.deleted": {
      analytics?.capture({ event: "User Deleted", distinctId: event.data.id });
      break;
    }
    case "organization.created":
    case "organization.updated": {
      const organization = event.data;
      if (event.event === "organization.created") {
        await database.org.upsert({
          where: { id: organization.id },
          create: {
            id: organization.id,
            name: organization.name,
            trialEndsAt: trialEndsAt(),
          },
          update: { name: organization.name },
        });
      } else {
        // Only rename: a late update for a deleted shop mustn't bring it back.
        await database.org.updateMany({
          where: { id: organization.id },
          data: { name: organization.name },
        });
      }
      analytics?.groupIdentify({
        groupKey: organization.id,
        groupType: "company",
        properties: { name: organization.name },
      });
      break;
    }
    case "organization.deleted": {
      await database.org.deleteMany({ where: { id: event.data.id } });
      break;
    }
    case "organization_membership.created":
    case "organization_membership.updated": {
      const membership = event.data;
      // The Org row may not exist yet if events arrive out of order.
      const org = await database.org.findUnique({
        where: { id: membership.organizationId },
      });
      if (org) {
        await database.member.upsert({
          where: {
            orgId_userId: {
              orgId: membership.organizationId,
              userId: membership.userId,
            },
          },
          create: {
            orgId: membership.organizationId,
            userId: membership.userId,
          },
          update: {},
        });
      }
      analytics?.capture({
        event: "Organization Member Created",
        distinctId: membership.userId,
        groups: { company: membership.organizationId },
      });
      break;
    }
    case "organization_membership.deleted": {
      const membership = event.data;
      await database.member.deleteMany({
        where: { orgId: membership.organizationId, userId: membership.userId },
      });
      analytics?.capture({
        event: "Organization Member Deleted",
        distinctId: membership.userId,
      });
      break;
    }
    default: {
      break;
    }
  }
};

export const POST = async (request: Request): Promise<Response> => {
  if (!env.WORKOS_WEBHOOK_SECRET) {
    return NextResponse.json({ message: "Not configured", ok: false });
  }

  const signature = request.headers.get("workos-signature");
  if (!signature) {
    return new Response("Missing WorkOS-Signature header", { status: 400 });
  }

  let event: WebhookEvent;
  try {
    event = await getWorkOS().webhooks.constructEvent({
      payload: (await request.json()) as Record<string, unknown>,
      sigHeader: signature,
      secret: env.WORKOS_WEBHOOK_SECRET,
    });
  } catch (error) {
    log.error("Error verifying WorkOS webhook:", { error });
    return new Response("Invalid signature", { status: 400 });
  }

  log.info("WorkOS webhook", { id: event.id, type: event.event });
  await handleEvent(event);
  await analytics?.shutdown();

  return new Response("OK", { status: 200 });
};

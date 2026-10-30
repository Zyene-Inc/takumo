import { NextRequest } from "next/server";
import { beforeEach, expect, test, vi } from "vitest";

const session = { user: null as null | { id: string } };

// Mock the copy @repo/auth resolves (pnpm can install one copy per peer set).
vi.mock(
  "../../../packages/auth/node_modules/@workos-inc/authkit-nextjs",
  async () => {
    const { NextResponse } = await import("next/server");
    return {
      authkit: vi.fn(async () => ({
        session,
        headers: new Headers(),
        authorizationUrl: "https://auth.workos.test/authorize",
      })),
      handleAuthkitHeaders: vi.fn(
        (
          _request: NextRequest,
          _headers: Headers,
          options?: { redirect?: string }
        ) =>
          options?.redirect
            ? NextResponse.redirect(options.redirect)
            : NextResponse.next()
      ),
      partitionAuthkitHeaders: vi.fn(() => ({
        requestHeaders: new Headers(),
        responseHeaders: new Headers(),
      })),
      applyResponseHeaders: vi.fn(),
    };
  }
);

const { authMiddleware } = await import("@repo/auth/proxy");

const proxy = authMiddleware(undefined, {
  publicPaths: ["/sign-in", "/callback"],
});
const event = {} as Parameters<typeof proxy>[1];
const request = (path: string) =>
  new NextRequest(new URL(path, "http://localhost:3000"));

beforeEach(() => {
  session.user = null;
});

test("signed-out users are sent to WorkOS on protected paths", async () => {
  const response = await proxy(request("/schedule"), event);
  expect(response.headers.get("location")).toBe(
    "https://auth.workos.test/authorize"
  );
});

test("public paths stay reachable when signed out", async () => {
  const response = await proxy(request("/callback"), event);
  expect(response.headers.get("location")).toBeNull();
});

test("signed-in users pass through", async () => {
  session.user = { id: "user_123" };
  const response = await proxy(request("/schedule"), event);
  expect(response.headers.get("location")).toBeNull();
});

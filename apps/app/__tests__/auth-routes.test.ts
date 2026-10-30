import { beforeEach, expect, test, vi } from "vitest";

const redirect = vi.fn();

vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@repo/auth/server", () => ({
  getSignInUrl: vi.fn(async () => "https://auth.workos.test/sign-in"),
  getSignUpUrl: vi.fn(async () => "https://auth.workos.test/sign-up"),
}));

beforeEach(() => {
  redirect.mockClear();
});

test("/sign-in redirects to WorkOS hosted sign-in", async () => {
  const { GET } = await import("../app/sign-in/route");
  await GET();
  expect(redirect).toHaveBeenCalledWith("https://auth.workos.test/sign-in");
});

test("/sign-up redirects to WorkOS hosted sign-up", async () => {
  const { GET } = await import("../app/sign-up/route");
  await GET();
  expect(redirect).toHaveBeenCalledWith("https://auth.workos.test/sign-up");
});

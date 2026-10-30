import {
  applyResponseHeaders,
  authkit,
  handleAuthkitHeaders,
  type NoUserInfo,
  partitionAuthkitHeaders,
  type UserInfo,
} from "@workos-inc/authkit-nextjs";
import type { NextFetchEvent, NextRequest, NextResponse } from "next/server";

type AuthSession = UserInfo | NoUserInfo;

type ProxyHandler = (
  session: AuthSession,
  request: NextRequest,
  event: NextFetchEvent
) => Response | undefined | Promise<Response | undefined>;

interface AuthMiddlewareOptions {
  /**
   * Paths that signed-out users may visit. When set, every other path
   * redirects to WorkOS sign-in. When omitted, nothing is protected.
   */
  publicPaths?: string[];
}

const isPublic = (pathname: string, publicPaths: string[]) =>
  publicPaths.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`)
  );

/**
 * WorkOS AuthKit session handling, composed with other proxy logic.
 * The handler's response wins for redirects/rewrites; for pass-through
 * responses its headers (e.g. security headers) are merged in.
 */
export const authMiddleware =
  (handler?: ProxyHandler, options: AuthMiddlewareOptions = {}) =>
  async (request: NextRequest, event: NextFetchEvent) => {
    const { session, headers, authorizationUrl } = await authkit(request);
    const { publicPaths } = options;

    if (
      publicPaths &&
      !session.user &&
      authorizationUrl &&
      !isPublic(request.nextUrl.pathname, publicPaths)
    ) {
      return handleAuthkitHeaders(request, headers, {
        redirect: authorizationUrl,
      });
    }

    const handlerResponse = await handler?.(session, request, event);
    const passesThrough =
      !handlerResponse ||
      handlerResponse.headers.get("x-middleware-next") === "1";

    if (!passesThrough) {
      const { responseHeaders } = partitionAuthkitHeaders(request, headers);
      applyResponseHeaders(handlerResponse as NextResponse, responseHeaders);
      return handlerResponse;
    }

    const response = handleAuthkitHeaders(request, headers);
    handlerResponse?.headers.forEach((value, key) => {
      if (!key.startsWith("x-middleware-")) {
        response.headers.set(key, value);
      }
    });

    return response;
  };

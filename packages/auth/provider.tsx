"use client";

import { AuthKitProvider } from "@workos-inc/authkit-nextjs/components";
import type { ReactNode } from "react";

interface AuthProviderProperties {
  readonly children: ReactNode;
}

export const AuthProvider = ({ children }: AuthProviderProperties) => (
  <AuthKitProvider>{children}</AuthKitProvider>
);

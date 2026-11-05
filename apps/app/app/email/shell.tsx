import type { ReactNode } from "react";

/** The simple page around email-link screens: readable on a phone. */
export const EmailShell = ({
  title,
  children,
}: {
  children: ReactNode;
  title: string;
}) => (
  <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-4 py-10">
    <div>
      <p className="text-muted-foreground text-sm">Takumo 匠</p>
      <h1 className="mt-1 font-semibold text-2xl">{title}</h1>
    </div>
    {children}
  </main>
);

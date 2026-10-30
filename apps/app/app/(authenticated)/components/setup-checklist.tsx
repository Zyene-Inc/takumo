import { Button } from "@repo/design-system/components/ui/button";
import { Progress } from "@repo/design-system/components/ui/progress";
import { cn } from "@repo/design-system/lib/utils";
import { CheckCircle2Icon, CircleIcon } from "lucide-react";
import Link from "next/link";
import type { SetupStep } from "@/lib/onboarding";
import { createDemoShop } from "../../actions/auth";

/** "Get Takumo running": what's done and the next step. */
export const SetupChecklist = ({
  steps,
  done,
  empty,
}: {
  done: number;
  empty: boolean;
  steps: SetupStep[];
}) => {
  const next = steps.find((s) => !s.done);
  return (
    <section className="grid gap-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold">Get Takumo running</h2>
          <p className="text-muted-foreground text-sm">
            {done} of {steps.length} done
            {next ? `. Next: ${next.label.toLowerCase()}.` : "."}
          </p>
        </div>
        {empty && (
          <form action={createDemoShop}>
            <Button size="sm" type="submit" variant="outline">
              Try a demo shop first
            </Button>
          </form>
        )}
      </div>
      <Progress value={(done / steps.length) * 100} />
      <ol className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
        {steps.map((step) => (
          <li key={step.key}>
            <Link
              className={cn(
                "flex gap-2 rounded-lg p-2 text-sm hover:bg-muted/60",
                step === next && "bg-muted/60"
              )}
              href={step.href}
            >
              {step.done ? (
                <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-emerald-600" />
              ) : (
                <CircleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              )}
              <span>
                <span
                  className={cn(
                    "font-medium",
                    step.done && "text-muted-foreground line-through"
                  )}
                >
                  {step.label}
                </span>
                {!step.done && (
                  <span className="block text-muted-foreground text-xs">
                    {step.why}
                  </span>
                )}
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
};

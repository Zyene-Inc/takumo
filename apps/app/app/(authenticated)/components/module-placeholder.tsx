import { Header } from "./header";

interface ModulePlaceholderProperties {
  readonly description: string;
  readonly phase: string;
  readonly section: string;
  readonly title: string;
}

// Temporary page body for modules that are on the roadmap but not built yet.
// See docs/TAKUMO.md section 13.
export const ModulePlaceholder = ({
  title,
  section,
  phase,
  description,
}: ModulePlaceholderProperties) => (
  <>
    <Header page={title} pages={[section]} />
    <div className="flex flex-1 flex-col gap-2 p-4 pt-0">
      <div className="rounded-xl bg-muted/50 p-6">
        <p className="text-muted-foreground text-sm">{phase}</p>
        <p className="mt-1 font-medium text-lg">{title}</p>
        <p className="mt-2 max-w-2xl text-muted-foreground text-sm">
          {description}
        </p>
      </div>
    </div>
  </>
);

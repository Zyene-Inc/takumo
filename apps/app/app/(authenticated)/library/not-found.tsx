import { Button } from "@repo/design-system/components/ui/button";
import Link from "next/link";

/**
 * A library link that leads nowhere: deleted, moved out of reach, mistyped,
 * or another shop's. Says the same in every case, so it reveals nothing.
 */
const LibraryNotFound = () => (
  <div className="grid max-w-md gap-3 p-8">
    <h1 className="font-semibold text-lg">That isn't in Company Knowledge</h1>
    <p className="text-muted-foreground text-sm">
      It may have been deleted, or the link is wrong.
    </p>
    <div>
      <Button asChild size="sm" variant="outline">
        <Link href="/library">Go to Company Knowledge</Link>
      </Button>
    </div>
  </div>
);

export default LibraryNotFound;

"use client";

import { Button } from "@repo/design-system/components/ui/button";

/** Something went wrong loading a library page: say so plainly, offer a retry. */
const LibraryError = ({ reset }: { error: Error; reset: () => void }) => (
  <div className="grid max-w-md gap-3 p-8" role="alert">
    <h1 className="font-semibold text-lg">The library couldn't load</h1>
    <p className="text-muted-foreground text-sm">
      Something went wrong on our side. Try again in a moment.
    </p>
    <div>
      <Button onClick={reset} size="sm">
        Try again
      </Button>
    </div>
  </div>
);

export default LibraryError;

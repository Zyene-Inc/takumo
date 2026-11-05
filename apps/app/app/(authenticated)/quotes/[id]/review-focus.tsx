"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import type { Box } from "@/lib/quotes/types";

/** A spot on a line's drawing to show: picked from a value, flag or source. */
interface Focus {
  box: Box | null;
  /** What was picked, shown beside the highlight. */
  label: string;
  lineId: string;
  sheet: number | null;
}

interface FocusState {
  focus: Focus | null;
  show: (focus: Focus, options?: { scroll?: boolean }) => void;
}

const FocusContext = createContext<FocusState>({
  focus: null,
  show: () => undefined,
});

export const lineAnchor = (lineId: string) => `line-${lineId}`;

/** Shares the picked drawing spot between the values and the viewer. */
export const ReviewFocusProvider = ({ children }: { children: ReactNode }) => {
  const [focus, setFocus] = useState<Focus | null>(null);
  const show = useCallback<FocusState["show"]>((next, options) => {
    setFocus(next);
    if (options?.scroll) {
      document
        .getElementById(lineAnchor(next.lineId))
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);
  const value = useMemo(() => ({ focus, show }), [focus, show]);
  return (
    <FocusContext.Provider value={value}>{children}</FocusContext.Provider>
  );
};

export const useReviewFocus = () => useContext(FocusContext);

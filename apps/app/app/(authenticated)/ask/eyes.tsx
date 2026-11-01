"use client";

import { cn } from "@repo/design-system/lib/utils";
import { useEffect, useRef } from "react";

// Takumo's face: two eyes that follow the pointer and blink now and then.
// While thinking they glance around instead. Still for reduced motion.

/** How far a pupil can travel inside its eye, in viewBox units. */
const REACH = 2.6;
const EYES = [
  { cx: 24, cy: 31 },
  { cx: 40, cy: 31 },
] as const;

const GLANCE: Keyframe[] = [
  { transform: "translate(0, 0)" },
  { transform: `translate(${-REACH}px, -1px)`, offset: 0.2 },
  { transform: `translate(${-REACH}px, -1px)`, offset: 0.4 },
  { transform: `translate(${REACH}px, -1px)`, offset: 0.6 },
  { transform: `translate(${REACH}px, -1px)`, offset: 0.8 },
  { transform: "translate(0, 0)" },
];

export const TakumoEyes = ({
  className,
  thinking = false,
}: {
  className?: string;
  thinking?: boolean;
}) => {
  const svg = useRef<SVGSVGElement>(null);
  const pupils = useRef<(SVGCircleElement | null)[]>([]);
  const lids = useRef<SVGGElement>(null);

  useEffect(() => {
    const el = svg.current;
    if (
      !el ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const cleanups: (() => void)[] = [];

    // Blink every 2.5 to 7 seconds.
    let blinkTimer = 0;
    const blink = () => {
      lids.current?.animate(
        [
          { transform: "scaleY(1)" },
          { transform: "scaleY(0.1)" },
          { transform: "scaleY(1)" },
        ],
        { duration: 160, easing: "ease-in-out" }
      );
      blinkTimer = window.setTimeout(blink, 2500 + Math.random() * 4500);
    };
    blinkTimer = window.setTimeout(blink, 1200 + Math.random() * 2000);
    cleanups.push(() => window.clearTimeout(blinkTimer));

    if (thinking) {
      for (const p of pupils.current) {
        const glance = p?.animate(GLANCE, {
          duration: 2400,
          iterations: Number.POSITIVE_INFINITY,
          easing: "ease-in-out",
        });
        cleanups.push(() => glance?.cancel());
      }
    } else {
      // Look toward the pointer, further the further away it is.
      const look = (e: PointerEvent) => {
        const rect = el.getBoundingClientRect();
        const dx = e.clientX - (rect.left + rect.width / 2);
        const dy = e.clientY - (rect.top + rect.height / 2);
        const distance = Math.hypot(dx, dy) || 1;
        const pull = Math.min(1, distance / 240) * REACH;
        const x = (dx / distance) * pull;
        const y = (dy / distance) * pull;
        for (const p of pupils.current) {
          p?.style.setProperty("transform", `translate(${x}px, ${y}px)`);
        }
      };
      window.addEventListener("pointermove", look, { passive: true });
      cleanups.push(() => window.removeEventListener("pointermove", look));
    }

    return () => {
      for (const c of cleanups) {
        c();
      }
    };
  }, [thinking]);

  return (
    <svg
      aria-hidden="true"
      className={cn("size-12 text-primary", className)}
      ref={svg}
      viewBox="0 0 64 64"
    >
      <circle cx="32" cy="32" fill="currentColor" r="32" />
      <g
        ref={lids}
        style={{ transformBox: "fill-box", transformOrigin: "center" }}
      >
        {EYES.map((eye, i) => (
          <g key={eye.cx}>
            <ellipse cx={eye.cx} cy={eye.cy} fill="white" rx="6" ry="7.5" />
            <circle
              cx={eye.cx}
              cy={eye.cy + 0.5}
              fill="#0A0B0D"
              r="3.2"
              ref={(node) => {
                pupils.current[i] = node;
              }}
              style={{ transition: "transform 120ms ease-out" }}
            />
          </g>
        ))}
      </g>
    </svg>
  );
};

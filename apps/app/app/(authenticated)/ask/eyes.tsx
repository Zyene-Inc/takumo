"use client";

import { cn } from "@repo/design-system/lib/utils";
import { useEffect, useRef } from "react";

// Takumo's face: a machine-shop gear with two eyes, a soft glow and a gentle
// float. Its mood follows the conversation:
//   idle      eyes follow the pointer and blink now and then
//   typing    eyes look down at the question box
//   thinking  the gear turns, the eyes glance around, the float quickens
//   happy     eyes smile for a moment when an answer lands
// Still (no float, glow pulse, glances or tracking) for reduced motion.

export type TakumoMood = "idle" | "typing" | "thinking" | "happy";

/** How far a pupil can travel inside its eye, in viewBox units. */
const REACH = 2.6;
const EYES = [
  { cx: 24, cy: 31 },
  { cx: 40, cy: 31 },
] as const;

/** An 8-tooth gear around the centre of the 64 × 64 view box. */
const GEAR = (() => {
  const teeth = 8;
  const outer = 31;
  const root = 25.5;
  const step = (2 * Math.PI) / teeth;
  const at = (r: number, a: number) =>
    `${(32 + r * Math.cos(a)).toFixed(2)} ${(32 + r * Math.sin(a)).toFixed(2)}`;
  const points: string[] = [];
  for (let i = 0; i < teeth; i++) {
    const a = i * step - Math.PI / 2;
    // Root, then a slightly tapered tooth.
    points.push(
      at(root, a - step * 0.3),
      at(outer, a - step * 0.2),
      at(outer, a + step * 0.2),
      at(root, a + step * 0.3)
    );
  }
  return `M ${points.join(" L ")} Z`;
})();

const GLANCE: Keyframe[] = [
  { transform: "translate(0, 0)" },
  { transform: `translate(${-REACH}px, -1px)`, offset: 0.2 },
  { transform: `translate(${-REACH}px, -1px)`, offset: 0.4 },
  { transform: `translate(${REACH}px, -1px)`, offset: 0.6 },
  { transform: `translate(${REACH}px, -1px)`, offset: 0.8 },
  { transform: "translate(0, 0)" },
];

const FOREVER = Number.POSITIVE_INFINITY;

const stillPreferred = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Blinks every 2.5 to 7 seconds. Returns a stop function. */
const startBlinking = (lids: SVGGElement) => {
  let timer = 0;
  const blink = () => {
    lids.animate(
      [
        { transform: "scaleY(1)" },
        { transform: "scaleY(0.1)" },
        { transform: "scaleY(1)" },
      ],
      { duration: 160, easing: "ease-in-out" }
    );
    timer = window.setTimeout(blink, 2500 + Math.random() * 4500);
  };
  timer = window.setTimeout(blink, 1200 + Math.random() * 2000);
  return () => window.clearTimeout(timer);
};

/** Points the pupils toward the pointer, further the further away it is. */
const startTracking = (svg: SVGSVGElement, pupils: SVGGElement[]) => {
  const look = (e: PointerEvent) => {
    const rect = svg.getBoundingClientRect();
    const dx = e.clientX - (rect.left + rect.width / 2);
    const dy = e.clientY - (rect.top + rect.height / 2);
    const distance = Math.hypot(dx, dy) || 1;
    const pull = Math.min(1, distance / 240) * REACH;
    for (const p of pupils) {
      p.style.transform = `translate(${(dx / distance) * pull}px, ${(dy / distance) * pull}px)`;
    }
  };
  window.addEventListener("pointermove", look, { passive: true });
  return () => window.removeEventListener("pointermove", look);
};

/** Runs looping animations and returns a function that cancels them. */
const loop = (items: [Element | null, Keyframe[], number][]) => {
  const running = items.map(([el, frames, duration]) =>
    el?.animate(frames, {
      duration,
      iterations: FOREVER,
      easing: "ease-in-out",
    })
  );
  return () => {
    for (const a of running) {
      a?.cancel();
    }
  };
};

export const TakumoEyes = ({
  className,
  mood = "idle",
  glow = false,
  live = true,
}: {
  className?: string;
  /** A soft breathing halo; for the big face on the start screen. */
  glow?: boolean;
  /** False draws a still face, for avatars on older answers. */
  live?: boolean;
  mood?: TakumoMood;
}) => {
  const svg = useRef<SVGSVGElement>(null);
  const pupils = useRef<(SVGGElement | null)[]>([]);
  const lids = useRef<SVGGElement>(null);
  const gear = useRef<SVGPathElement>(null);
  const halo = useRef<HTMLSpanElement>(null);
  const body = useRef<HTMLSpanElement>(null);

  // Float and glow run in every mood; thinking makes them quicker.
  useEffect(() => {
    if (!live || stillPreferred()) {
      return;
    }
    const busy = mood === "thinking";
    return loop([
      [
        body.current,
        [
          { transform: "translateY(0)" },
          { transform: "translateY(-6%)" },
          { transform: "translateY(0)" },
        ],
        busy ? 1400 : 3600,
      ],
      [
        halo.current,
        [
          { opacity: 0.6, transform: "scale(0.9) rotate(0deg)" },
          { opacity: 1, transform: "scale(1.15) rotate(180deg)" },
          { opacity: 0.6, transform: "scale(0.9) rotate(360deg)" },
        ],
        busy ? 2400 : 9000,
      ],
    ]);
  }, [mood, live]);

  useEffect(() => {
    const el = svg.current;
    const eyes = pupils.current.filter((p): p is SVGGElement => Boolean(p));
    if (!(el && live) || mood === "happy" || stillPreferred()) {
      return;
    }
    const stops = [lids.current ? startBlinking(lids.current) : () => null];
    if (mood === "thinking") {
      stops.push(
        loop([
          [
            gear.current,
            [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }],
            6000,
          ],
          ...eyes.map((p): [Element, Keyframe[], number] => [p, GLANCE, 2400]),
        ])
      );
    } else if (mood === "typing") {
      for (const p of eyes) {
        p.style.transform = `translate(0px, ${REACH}px)`;
      }
    } else {
      stops.push(startTracking(el, eyes));
    }
    return () => {
      for (const stop of stops) {
        stop();
      }
    };
  }, [mood, live]);

  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative inline-grid size-12 shrink-0 text-primary",
        className
      )}
    >
      {glow && (
        <span
          className="pointer-events-none absolute -inset-1/4 rounded-full blur-xl"
          ref={halo}
          style={{
            background:
              "conic-gradient(from 90deg, #7dd3fc, #38bdf8, #0ea5e9, #0284c7, #38bdf8, #7dd3fc)",
          }}
        />
      )}
      <span className="relative" ref={body}>
        <svg
          aria-hidden="true"
          className="size-full drop-shadow-sm"
          ref={svg}
          viewBox="0 0 64 64"
        >
          <path
            d={GEAR}
            fill="currentColor"
            ref={gear}
            stroke="currentColor"
            strokeLinejoin="round"
            strokeWidth="2"
            style={{ transformOrigin: "32px 32px" }}
          />
          {mood === "happy" ? (
            // Smiling eyes: two arcs.
            <g
              fill="none"
              stroke="white"
              strokeLinecap="round"
              strokeWidth="3.2"
            >
              {EYES.map((eye) => (
                <path
                  d={`M ${eye.cx - 5} ${eye.cy + 1.5} Q ${eye.cx} ${eye.cy - 6} ${eye.cx + 5} ${eye.cy + 1.5}`}
                  key={eye.cx}
                />
              ))}
            </g>
          ) : (
            <g
              ref={lids}
              style={{ transformBox: "fill-box", transformOrigin: "center" }}
            >
              {EYES.map((eye, i) => (
                <g key={eye.cx}>
                  <ellipse
                    cx={eye.cx}
                    cy={eye.cy}
                    fill="white"
                    rx="6"
                    ry="7.5"
                  />
                  <g
                    ref={(node) => {
                      pupils.current[i] = node;
                    }}
                    style={{ transition: "transform 150ms ease-out" }}
                  >
                    <circle
                      cx={eye.cx}
                      cy={eye.cy + 0.5}
                      fill="#0f172a"
                      r="3.2"
                    />
                    {/* A catch-light makes the eyes look alive. */}
                    <circle
                      cx={eye.cx + 1.2}
                      cy={eye.cy - 0.8}
                      fill="white"
                      r="1"
                    />
                  </g>
                </g>
              ))}
            </g>
          )}
        </svg>
      </span>
    </span>
  );
};

"use client";

import { useEffect, useRef } from "react";
import type { BrainLink, BrainNode } from "@/lib/knowledge/brain";
import type { BrainMode } from "./brain-layout";
import { buildScene, drawScene, nodeAt, type Scene, type View } from "./draw";

export type { BrainMode } from "./brain-layout";

interface Callbacks {
  matchIds: Set<string> | null;
  onHover: (hover: { id: string; x: number; y: number } | null) => void;
  onSelect: (id: string | null) => void;
  selectedId: string | null;
}

/**
 * Runs the canvas: sizing, the spin loop (only while on screen) and pointer
 * input. Returns a redraw function and a cleanup.
 */
const mount = (
  el: HTMLCanvasElement,
  wrap: HTMLDivElement,
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  props: { current: Callbacks }
) => {
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const view: View = {
    dpr: 1,
    width: 0,
    height: 0,
    yaw: 0.5,
    pitch: 0.28,
    panX: 0,
    panY: 0,
    zoom: 1,
  };
  const resize = () => {
    view.dpr = Math.min(window.devicePixelRatio || 1, 2);
    view.width = wrap.clientWidth;
    view.height = wrap.clientHeight;
    el.width = Math.max(1, Math.round(view.width * view.dpr));
    el.height = Math.max(1, Math.round(view.height * view.dpr));
    el.style.width = `${view.width}px`;
    el.style.height = `${view.height}px`;
  };
  const draw = () =>
    drawScene(
      ctx,
      scene,
      view,
      props.current.selectedId,
      props.current.matchIds
    );

  const drag = { on: false, moved: 0, x: 0, y: 0 };
  let frame = 0;
  let visible = false;
  let shown = !document.hidden;
  const spins = () => scene.mode === "globe" && !still;
  const tick = () => {
    if (!(drag.on || props.current.selectedId) && spins()) {
      view.yaw += 0.0017;
    }
    draw();
    frame = requestAnimationFrame(tick);
  };
  const stop = () => {
    cancelAnimationFrame(frame);
    frame = 0;
  };
  const update = () => {
    const on = visible && shown;
    if (on && (drag.on || spins())) {
      // Paint now rather than waiting a frame, which a background tab may not get.
      if (!frame) {
        draw();
        frame = requestAnimationFrame(tick);
      }
      return;
    }
    stop();
    if (on) {
      draw();
    }
  };
  const redraw = () => {
    if (!frame && visible && shown) {
      draw();
    }
  };

  const local = (e: PointerEvent) => {
    const rect = el.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const hover = (e: PointerEvent) => {
    const { x, y } = local(e);
    const best = nodeAt(scene, x, y);
    const p = scene.placed[best];
    props.current.onHover(p ? { id: p.id, x: p.sx, y: p.sy } : null);
    el.style.cursor = p ? "pointer" : "grab";
  };
  const down = (e: PointerEvent) => {
    Object.assign(drag, { on: true, moved: 0, x: e.clientX, y: e.clientY });
    el.setPointerCapture(e.pointerId);
    el.style.cursor = "grabbing";
    props.current.onHover(null);
    update();
  };
  const move = (e: PointerEvent) => {
    if (!drag.on) {
      hover(e);
      return;
    }
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    Object.assign(drag, { x: e.clientX, y: e.clientY });
    drag.moved += Math.abs(dx) + Math.abs(dy);
    if (scene.mode === "globe") {
      view.yaw += 0.006 * dx;
      view.pitch = Math.max(-1.2, Math.min(1.2, view.pitch + 0.005 * dy));
    } else {
      view.panX += dx / view.zoom;
      view.panY += dy / view.zoom;
      draw();
    }
  };
  const up = (e: PointerEvent) => {
    if (!drag.on) {
      return;
    }
    drag.on = false;
    el.style.cursor = "grab";
    update();
    if (drag.moved > 5) {
      return;
    }
    const { x, y } = local(e);
    const id = scene.placed[nodeAt(scene, x, y)]?.id ?? null;
    props.current.onSelect(id === props.current.selectedId ? null : id);
  };
  const leave = () => props.current.onHover(null);
  // The flat view zooms with a pinch or ctrl+scroll; plain scroll moves the page.
  const wheel = (e: WheelEvent) => {
    if (scene.mode !== "flat" || !e.ctrlKey) {
      return;
    }
    e.preventDefault();
    view.zoom = Math.max(
      0.4,
      Math.min(6, view.zoom * Math.exp(-e.deltaY * 0.01))
    );
    draw();
  };

  resize();
  const seen = new IntersectionObserver(
    ([entry]) => {
      visible = entry.isIntersecting;
      update();
    },
    { threshold: 0.05 }
  );
  seen.observe(wrap);
  const sized = new ResizeObserver(() => {
    resize();
    redraw();
  });
  sized.observe(wrap);
  const onVisibility = () => {
    shown = !document.hidden;
    update();
  };
  document.addEventListener("visibilitychange", onVisibility);
  const pointer = [
    ["pointerdown", down],
    ["pointermove", move],
    ["pointerup", up],
    ["pointercancel", up],
    ["pointerleave", leave],
  ] as const;
  for (const [type, fn] of pointer) {
    el.addEventListener(type, fn);
  }
  el.addEventListener("wheel", wheel, { passive: false });
  el.style.cursor = "grab";

  return {
    redraw,
    cleanup: () => {
      stop();
      seen.disconnect();
      sized.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      for (const [type, fn] of pointer) {
        el.removeEventListener(type, fn);
      }
      el.removeEventListener("wheel", wheel);
    },
  };
};

export const BrainCanvas = ({
  nodes,
  links,
  mode,
  selectedId,
  matchIds,
  onSelect,
  onHover,
}: Callbacks & {
  links: BrainLink[];
  mode: BrainMode;
  nodes: BrainNode[];
}) => {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const redraw = useRef<(() => void) | null>(null);
  const props = useRef<Callbacks>({ selectedId, matchIds, onSelect, onHover });
  props.current = { selectedId, matchIds, onSelect, onHover };

  // Selection and search change the picture, not the layout.
  // biome-ignore lint/correctness/useExhaustiveDependencies: redraw on these
  useEffect(() => {
    redraw.current?.();
  }, [selectedId, matchIds]);

  useEffect(() => {
    const el = canvas.current;
    const wrap = box.current;
    const ctx = el?.getContext("2d");
    if (!(el && wrap && ctx)) {
      return;
    }
    const run = mount(el, wrap, ctx, buildScene(nodes, links, mode), props);
    redraw.current = run.redraw;
    return () => {
      redraw.current = null;
      run.cleanup();
    };
  }, [nodes, links, mode]);

  return (
    <div className="absolute inset-0" ref={box}>
      <canvas
        aria-label="Shop brain knowledge map"
        className="block touch-none"
        ref={canvas}
        role="img"
      />
    </div>
  );
};

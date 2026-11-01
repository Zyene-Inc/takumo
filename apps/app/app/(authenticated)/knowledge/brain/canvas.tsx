"use client";

import { useEffect, useRef } from "react";
import {
  BRAIN_TYPE_COLOR,
  BRAIN_TYPES,
  type BrainLink,
  type BrainNode,
} from "@/lib/knowledge/brain";

export type BrainMode = "globe" | "flat";

interface Placed {
  color: string;
  degree: number;
  /** 0 at the back of the globe, 1 at the front. Always 1 when flat. */
  depth: number;
  id: string;
  label: string;
  /** Hit and draw radius on screen. */
  r: number;
  /** Distance from the centre, kept while relaxing the globe. */
  shell: number;
  sx: number;
  sy: number;
  x: number;
  y: number;
  z: number;
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const HIGHLIGHT = "#F5C200";

/** Same graph, same picture: a seeded generator instead of Math.random. */
const seeded = (seed: number) => {
  let s = seed % 2_147_483_647 || 1;
  return () => {
    s = (s * 16_807) % 2_147_483_647;
    return s / 2_147_483_647;
  };
};

/** Each type on the map gets its own direction, spread evenly over the sphere. */
const typeAnchors = (types: string[]) => {
  const present = BRAIN_TYPES.filter((t) => types.includes(t));
  const anchors = new Map<string, [number, number, number]>();
  present.forEach((type, i) => {
    const phi = Math.acos(1 - (2 * (i + 0.5)) / present.length);
    const theta = GOLDEN * i;
    anchors.set(type, [
      Math.sin(phi) * Math.cos(theta),
      Math.sin(phi) * Math.sin(theta),
      Math.cos(phi),
    ]);
  });
  return anchors;
};

const index = (nodes: Placed[], links: BrainLink[]) => {
  const at = new Map(nodes.map((n, i) => [n.id, i]));
  const edges: [number, number][] = [];
  for (const l of links) {
    const a = at.get(l.source);
    const b = at.get(l.target);
    if (a !== undefined && b !== undefined && a !== b) {
      edges.push([a, b]);
    }
  }
  return { at, edges };
};

const separate = (nodes: Placed[], gap: number) => {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dz = a.z - b.z;
      const d = Math.hypot(dx, dy, dz);
      if (d >= gap || d === 0) {
        continue;
      }
      const push = (gap - d) / d / 2;
      a.x += dx * push;
      a.y += dy * push;
      a.z += dz * push;
      b.x -= dx * push;
      b.y -= dy * push;
      b.z -= dz * push;
    }
  }
};

const layoutGlobe = (
  input: BrainNode[],
  links: BrainLink[],
  types: string[]
) => {
  const rand = seeded(9176 + 31 * input.length);
  const jitter = () => (rand() + rand() + rand() + rand() - 2) * 0.9;
  const anchors = typeAnchors(types);
  const spread = input.length > 200 ? 0.24 : 0.32;
  const nodes: Placed[] = input.map((n, i) => {
    const a = anchors.get(n.type) ?? [0, 0, 1];
    const p = [
      a[0] + jitter() * spread,
      a[1] + jitter() * spread,
      a[2] + jitter() * spread,
    ];
    const len = Math.hypot(p[0], p[1], p[2]) || 1;
    const shell = 0.78 + 0.2 * rand();
    return {
      id: n.id,
      label: n.label,
      color: BRAIN_TYPE_COLOR[types[i] as keyof typeof BRAIN_TYPE_COLOR],
      degree: n.degree,
      x: (p[0] / len) * shell,
      y: (p[1] / len) * shell,
      z: (p[2] / len) * shell,
      shell,
      sx: 0,
      sy: 0,
      depth: 1,
      r: 0,
    };
  });
  const { at, edges } = index(nodes, links);
  // Linked records pull together, each stays near its type and on its shell,
  // and dots closer than `gap` push apart so busy parts don't swallow orders.
  const rounds = nodes.length > 300 ? 25 : 40;
  const gap = Math.min(0.3, Math.max(0.06, 1.7 / Math.sqrt(nodes.length || 1)));
  for (let k = 0; k < rounds; k++) {
    for (const [i, j] of edges) {
      const a = nodes[i];
      const b = nodes[j];
      const dx = (b.x - a.x) * 0.015;
      const dy = (b.y - a.y) * 0.015;
      const dz = (b.z - a.z) * 0.015;
      a.x += dx;
      a.y += dy;
      a.z += dz;
      b.x -= dx;
      b.y -= dy;
      b.z -= dz;
    }
    separate(nodes, gap);
    nodes.forEach((n, i) => {
      const a = anchors.get(types[i]) ?? [0, 0, 1];
      n.x += (a[0] - n.x) * 0.03;
      n.y += (a[1] - n.y) * 0.03;
      n.z += (a[2] - n.z) * 0.03;
      const len = Math.hypot(n.x, n.y, n.z) || 1;
      n.x = (n.x / len) * n.shell;
      n.y = (n.y / len) * n.shell;
      n.z = (n.z / len) * n.shell;
    });
  }
  return { nodes, at, edges };
};

const layoutFlat = (
  input: BrainNode[],
  links: BrainLink[],
  types: string[]
) => {
  const rand = seeded(4211 + 17 * input.length);
  const order = [...BRAIN_TYPES];
  const nodes: Placed[] = input.map((n, i) => {
    const angle =
      (order.indexOf(types[i] as never) / order.length) * 2 * Math.PI;
    return {
      id: n.id,
      label: n.label,
      color: BRAIN_TYPE_COLOR[types[i] as keyof typeof BRAIN_TYPE_COLOR],
      degree: n.degree,
      x: Math.cos(angle) * 0.6 + (rand() - 0.5) * 0.4,
      y: Math.sin(angle) * 0.6 + (rand() - 0.5) * 0.4,
      z: 0,
      shell: 1,
      sx: 0,
      sy: 0,
      depth: 1,
      r: 0,
    };
  });
  const { at, edges } = index(nodes, links);
  const n = nodes.length;
  const ideal = 1.6 / Math.sqrt(Math.max(n, 1));
  const rounds = n > 400 ? 90 : 160;
  const vx = new Float64Array(n);
  const vy = new Float64Array(n);
  for (let k = 0; k < rounds; k++) {
    const cool = 1 - k / rounds;
    vx.fill(0);
    vy.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = nodes[i].x - nodes[j].x;
        const dy = nodes[i].y - nodes[j].y;
        const d2 = dx * dx + dy * dy + 1e-4;
        const f = (ideal * ideal) / d2;
        vx[i] += dx * f;
        vy[i] += dy * f;
        vx[j] -= dx * f;
        vy[j] -= dy * f;
      }
    }
    for (const [i, j] of edges) {
      const dx = nodes[j].x - nodes[i].x;
      const dy = nodes[j].y - nodes[i].y;
      const d = Math.hypot(dx, dy) || 1e-3;
      const f = (d - ideal) / d / 2;
      vx[i] += dx * f;
      vy[i] += dy * f;
      vx[j] -= dx * f;
      vy[j] -= dy * f;
    }
    for (let i = 0; i < n; i++) {
      vx[i] -= nodes[i].x * 0.05;
      vy[i] -= nodes[i].y * 0.05;
      const len = Math.hypot(vx[i], vy[i]);
      const max = 0.08 * cool + 0.002;
      const s = len > max ? max / len : 1;
      nodes[i].x += vx[i] * s;
      nodes[i].y += vy[i] * s;
    }
  }
  // Fit to [-1, 1] so the camera starts with everything in view.
  let extent = 1e-3;
  for (const p of nodes) {
    extent = Math.max(extent, Math.abs(p.x), Math.abs(p.y));
  }
  for (const p of nodes) {
    p.x /= extent;
    p.y /= extent;
  }
  return { nodes, at, edges };
};

interface View {
  dpr: number;
  height: number;
  panX: number;
  panY: number;
  pitch: number;
  width: number;
  yaw: number;
  zoom: number;
}

interface Scene {
  at: Map<string, number>;
  edges: [number, number][];
  maxLabels: number;
  mode: BrainMode;
  neighbours: Map<number, Set<number>>;
  placed: Placed[];
  /** Node size scale: bigger dots when there are few of them. */
  size: number;
}

interface Focus {
  focus: number;
  /** Search matches; null when not searching. */
  matches: Set<string> | null;
  near: Set<number> | null;
}

const buildScene = (
  nodes: BrainNode[],
  links: BrainLink[],
  mode: BrainMode
): Scene => {
  const types = nodes.map((n) => n.type);
  const {
    nodes: placed,
    at,
    edges,
  } = mode === "globe"
    ? layoutGlobe(nodes, links, types)
    : layoutFlat(nodes, links, types);
  const neighbours = new Map<number, Set<number>>();
  for (const [a, b] of edges) {
    neighbours.set(a, (neighbours.get(a) ?? new Set()).add(b));
    neighbours.set(b, (neighbours.get(b) ?? new Set()).add(a));
  }
  const count = placed.length;
  return {
    mode,
    placed,
    at,
    edges,
    neighbours,
    size: Math.min(1.5, Math.max(0.75, Math.sqrt(280 / Math.max(1, count)))),
    maxLabels: count <= 45 ? count : 22,
  };
};

const dotRadius = (p: Placed, scale: number) =>
  (2.4 + Math.min(1.1 * Math.sqrt(p.degree), 5.5)) * scale;

const projectGlobe = (scene: Scene, view: View, radius: number) => {
  const cx = view.width / 2;
  const cy = view.height / 2;
  const cosY = Math.cos(view.yaw);
  const sinY = Math.sin(view.yaw);
  const cosP = Math.cos(view.pitch);
  const sinP = Math.sin(view.pitch);
  for (const p of scene.placed) {
    const x = p.x * cosY + p.z * sinY;
    const z1 = -p.x * sinY + p.z * cosY;
    const y = p.y * cosP - z1 * sinP;
    const z = p.y * sinP + z1 * cosP;
    const persp = 3 / (3 - z);
    p.sx = cx + x * radius * persp;
    p.sy = cy + y * radius * persp;
    p.depth = (z + 1) / 2;
    p.r = dotRadius(p, scene.size * persp);
  }
};

const projectFlat = (scene: Scene, view: View, radius: number) => {
  const cx = view.width / 2;
  const cy = view.height / 2;
  for (const p of scene.placed) {
    p.sx = cx + (p.x * radius + view.panX) * view.zoom;
    p.sy = cy + (p.y * radius + view.panY) * view.zoom;
    p.depth = 1;
    p.r = dotRadius(p, scene.size * Math.sqrt(view.zoom));
  }
};

/** Lit nodes are the selection and its neighbours, or the search matches. */
const isLit = (scene: Scene, f: Focus, i: number) => {
  if (f.focus >= 0) {
    return i === f.focus || Boolean(f.near?.has(i));
  }
  return f.matches ? f.matches.has(scene.placed[i].id) : true;
};

const edgeAlpha = (hot: boolean, dim: boolean, depth: number) => {
  if (hot) {
    return 1;
  }
  return dim ? 0.05 : 0.3 + 0.25 * depth;
};

const drawEdges = (ctx: CanvasRenderingContext2D, scene: Scene, f: Focus) => {
  const thin = scene.placed.length > 200 ? 0.8 : 1.1;
  ctx.lineCap = "round";
  for (const [i, j] of scene.edges) {
    const a = scene.placed[i];
    const b = scene.placed[j];
    const hot = f.focus >= 0 && (i === f.focus || j === f.focus);
    const dim =
      f.focus >= 0 ? !hot : !(isLit(scene, f, i) && isLit(scene, f, j));
    ctx.globalAlpha = edgeAlpha(hot, dim, (a.depth + b.depth) / 2);
    ctx.strokeStyle = hot ? HIGHLIGHT : a.color;
    ctx.lineWidth = hot ? 1.9 : thin;
    ctx.beginPath();
    ctx.moveTo(a.sx, a.sy);
    ctx.lineTo(b.sx, b.sy);
    ctx.stroke();
  }
};

/** Back to front, so nearer dots cover farther ones. Returns that order. */
const drawNodes = (ctx: CanvasRenderingContext2D, scene: Scene, f: Focus) => {
  const { placed } = scene;
  const order = placed
    .map((_, i) => i)
    .sort((a, b) => placed[a].depth - placed[b].depth);
  for (const i of order) {
    const p = placed[i];
    const isFocus = i === f.focus;
    ctx.globalAlpha = isLit(scene, f, i) ? 0.5 + 0.5 * p.depth : 0.12;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.sx, p.sy, p.r * (isFocus ? 1.35 : 1), 0, 2 * Math.PI);
    ctx.fill();
    if (isFocus) {
      ctx.globalAlpha = 1;
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#FFFFFF";
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  return order;
};

// Labels: the selection and its neighbours first, then search matches, then
// the best-connected nodes facing us, skipping any that would overlap.
const drawLabels = (
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  f: Focus,
  order: number[],
  width: number
) => {
  const { placed } = scene;
  const lit = (i: number) => isLit(scene, f, i);
  const rest = order
    .filter((i) => placed[i].depth > 0.4 && i !== f.focus && !f.near?.has(i))
    .sort(
      (a, b) =>
        Number(lit(b)) - Number(lit(a)) || placed[b].degree - placed[a].degree
    );
  const queue = f.focus >= 0 ? [f.focus, ...(f.near ?? []), ...rest] : rest;
  ctx.font = "600 11px Inter, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  const taken: { x: number; y: number; w: number }[] = [];
  for (const i of queue) {
    const p = placed[i];
    const must = i === f.focus || Boolean(f.near?.has(i));
    if (!(must || (taken.length < scene.maxLabels && lit(i)))) {
      continue;
    }
    const text = p.label.length > 26 ? `${p.label.slice(0, 25)}…` : p.label;
    const w = ctx.measureText(text).width + 10;
    // Near the right edge the label goes on the left of its dot.
    const right = p.sx + p.r + 4;
    const x = right + w > width - 4 ? p.sx - p.r - 4 - w : right;
    const y = p.sy - 8.5;
    const clash = taken.some(
      (t) => x < t.x + t.w && x + w > t.x && y < t.y + 17 && y + 17 > t.y
    );
    if (clash && i !== f.focus) {
      continue;
    }
    taken.push({ x, y, w });
    ctx.fillStyle = "rgba(10,11,13,0.82)";
    ctx.fillRect(x, y, w, 17);
    ctx.fillStyle = i === f.focus || p.degree >= 4 ? "#F2ECDD" : "#B8B2A4";
    ctx.fillText(text, x + 5, p.sy);
  }
};

const drawScene = (
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  view: View,
  selectedId: string | null,
  matches: Set<string> | null
) => {
  const { width, height, dpr } = view;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const radius =
    (scene.mode === "globe" ? 0.36 : 0.44) * Math.min(width, height);
  if (scene.mode === "globe") {
    projectGlobe(scene, view, radius);
  } else {
    projectFlat(scene, view, radius);
  }
  const focus = selectedId ? (scene.at.get(selectedId) ?? -1) : -1;
  const f: Focus = {
    focus,
    near: focus >= 0 ? (scene.neighbours.get(focus) ?? new Set()) : null,
    matches,
  };
  const cx = width / 2;
  const cy = height / 2;
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, 1.25 * radius);
  glow.addColorStop(0, "rgba(245,194,0,0.07)");
  glow.addColorStop(0.7, "rgba(245,194,0,0.02)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);
  drawEdges(ctx, scene, f);
  drawLabels(ctx, scene, f, drawNodes(ctx, scene, f), width);
};

/** The dot under the pointer, ignoring the far side of the globe. */
const nodeAt = (scene: Scene, x: number, y: number) => {
  let best = -1;
  let bestD = Number.POSITIVE_INFINITY;
  scene.placed.forEach((p, i) => {
    const d = Math.hypot(p.sx - x, p.sy - y);
    if (d < Math.max(9, p.r + 5) && d < bestD && p.depth > 0.25) {
      best = i;
      bestD = d;
    }
  });
  return best;
};

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

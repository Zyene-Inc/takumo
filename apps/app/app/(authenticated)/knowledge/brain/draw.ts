// Drawing the knowledge map: projection, edges, nodes, labels and hit testing.

import type { BrainLink, BrainNode } from "@/lib/knowledge/brain";
import {
  type BrainMode,
  HIGHLIGHT,
  layoutFlat,
  layoutGlobe,
  type Placed,
} from "./brain-layout";

export interface View {
  dpr: number;
  height: number;
  panX: number;
  panY: number;
  pitch: number;
  width: number;
  yaw: number;
  zoom: number;
}

export interface Scene {
  at: Map<string, number>;
  edges: [number, number][];
  maxLabels: number;
  mode: BrainMode;
  neighbours: Map<number, Set<number>>;
  placed: Placed[];
  /** Node size scale: bigger dots when there are few of them. */
  size: number;
}

export interface Focus {
  focus: number;
  /** Search matches; null when not searching. */
  matches: Set<string> | null;
  near: Set<number> | null;
}

export const buildScene = (
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

export const dotRadius = (p: Placed, scale: number) =>
  (2.4 + Math.min(1.1 * Math.sqrt(p.degree), 5.5)) * scale;

export const projectGlobe = (scene: Scene, view: View, radius: number) => {
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

export const projectFlat = (scene: Scene, view: View, radius: number) => {
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
export const isLit = (scene: Scene, f: Focus, i: number) => {
  if (f.focus >= 0) {
    return i === f.focus || Boolean(f.near?.has(i));
  }
  return f.matches ? f.matches.has(scene.placed[i].id) : true;
};

export const edgeAlpha = (hot: boolean, dim: boolean, depth: number) => {
  if (hot) {
    return 1;
  }
  return dim ? 0.05 : 0.3 + 0.25 * depth;
};

export const drawEdges = (
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  f: Focus
) => {
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
export const drawNodes = (
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  f: Focus
) => {
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
export const drawLabels = (
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

export const drawScene = (
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
export const nodeAt = (scene: Scene, x: number, y: number) => {
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

// Where each node of the knowledge map sits: on a globe or flat.

import {
  BRAIN_TYPE_COLOR,
  BRAIN_TYPES,
  type BrainLink,
  type BrainNode,
} from "@/lib/knowledge/brain";

export type BrainMode = "globe" | "flat";

export interface Placed {
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

export const GOLDEN = Math.PI * (3 - Math.sqrt(5));

export const HIGHLIGHT = "#F5C200";

/** Same graph, same picture: a seeded generator instead of Math.random. */
export const seeded = (seed: number) => {
  let s = seed % 2_147_483_647 || 1;
  return () => {
    s = (s * 16_807) % 2_147_483_647;
    return s / 2_147_483_647;
  };
};

/** Each type on the map gets its own direction, spread evenly over the sphere. */
export const typeAnchors = (types: string[]) => {
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

export const index = (nodes: Placed[], links: BrainLink[]) => {
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

export const separate = (nodes: Placed[], gap: number) => {
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

export const layoutGlobe = (
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

export const layoutFlat = (
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

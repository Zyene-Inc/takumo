#!/usr/bin/env node
// Fails when a hand-written source file is longer than the limit, so files
// stay small enough to read in one sitting. Limits and exemptions are listed
// in CONTRIBUTING.md; raise them there and here together.
//
//   pnpm check:size

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SOURCE_LIMIT = 600;
const TEST_LIMIT = 1000;

const SOURCE = /\.(ts|tsx|mts|mjs|js|py)$/;
const TEST = /(__tests__\/|\/tests?\/|\.test\.tsx?$|\.eval\.ts$|\/evals\/)/;

// Generated, vendored or data-only files.
const EXEMPT = [
  /^vendor\//,
  /\/generated\//,
  /\.d\.ts$/,
  /^packages\/design-system\/components\/ui\//,
  /^packages\/database\/demo\/data\.ts$/,
  /^packages\/database\/prisma\/migrations\//,
];

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => SOURCE.test(f) && !EXEMPT.some((re) => re.test(f)));

const tooLong = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // deleted in the working tree
  }
  const lines = text.split("\n").length;
  const limit = TEST.test(file) ? TEST_LIMIT : SOURCE_LIMIT;
  if (lines > limit) {
    tooLong.push({ file, lines, limit });
  }
}

if (tooLong.length) {
  console.error("Files over the size limit (split them by responsibility):");
  for (const { file, lines, limit } of tooLong.sort((a, b) => b.lines - a.lines)) {
    console.error(`  ${file}: ${lines} lines (limit ${limit})`);
  }
  process.exit(1);
}
console.log(`File sizes OK (${files.length} files checked).`);

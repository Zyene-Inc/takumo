#!/usr/bin/env node
// Is a service ready to launch? Checks which variables are set and well
// formed; never prints a value.
//
//   pnpm check:env app apps/app/.env.local      # a local env file
//   pnpm check:env app .env.production --production  # from `vercel env pull`
//   pnpm check:env web apps/web/.env.local
//
// Exit code 1 when a required variable is missing or malformed.
import { readFileSync } from "node:fs";
import { checkService, SERVICES } from "./env-rules.mjs";

const args = process.argv.slice(2);
const production = args.includes("--production");
const [serviceName, file] = args.filter((a) => !a.startsWith("--"));
const service = SERVICES[serviceName];
if (!service) {
  console.error(
    `Usage: check-env <${Object.keys(SERVICES).join("|")}> [env file] [--production]`
  );
  process.exit(2);
}

const QUOTED = /^(['"])(.*)\1$/;
const EXPORT = /^export\s+/;

const parse = (text) =>
  Object.fromEntries(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const i = line.indexOf("=");
        const value = line
          .slice(i + 1)
          .trim()
          .replace(QUOTED, "$2");
        return [line.slice(0, i).trim().replace(EXPORT, ""), value];
      })
  );

const env = file ? parse(readFileSync(file, "utf8")) : process.env;
const problems = checkService(service, env, { production });
const required = problems.filter((p) => p.level === "required");
const recommended = problems.filter((p) => p.level === "recommended");

console.log(`${service.label}${production ? " (production)" : ""}`);
for (const p of required) {
  console.log(`  ✗ ${p.name}: ${p.problem} (${p.why})`);
}
for (const p of recommended) {
  console.log(`  · ${p.name}: ${p.problem} (${p.why}; optional)`);
}
const total = Object.keys(service.required).length;
console.log(
  required.length
    ? `${required.length} of ${total} required settings need attention.`
    : `All ${total} required settings are in place.`
);
process.exit(required.length ? 1 : 0);

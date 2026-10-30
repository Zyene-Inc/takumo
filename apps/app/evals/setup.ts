import path from "node:path";
import { config } from "dotenv";

config({
  path: path.resolve(import.meta.dirname, "../.env.local"),
  quiet: true,
});

#!/usr/bin/env node
import { createAppRuntime } from "../../runtime.js";
import { createCli } from "./index.js";

const runtime = createAppRuntime();
try {
  process.exitCode = await createCli(runtime.deps).run(process.argv.slice(2));
} finally {
  await runtime.close();
}

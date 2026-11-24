#!/usr/bin/env node
import { createAppRuntime } from "../../runtime.js";
import { startMcpStdio } from "./stdio.js";

const runtime = createAppRuntime();

const shutdown = async (): Promise<void> => {
  await runtime.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await startMcpStdio(runtime.deps);

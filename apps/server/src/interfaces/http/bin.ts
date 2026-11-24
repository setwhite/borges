#!/usr/bin/env node
import { createAppRuntime } from "../../runtime.js";

const runtime = createAppRuntime();
const app = await runtime.http();
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";

const shutdown = async (): Promise<void> => {
  await app.close();
  await runtime.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
  await app.listen({ port, host });
} catch (error) {
  runtime.logger.error({ err: error }, "http server failed to start");
  process.exitCode = 1;
}

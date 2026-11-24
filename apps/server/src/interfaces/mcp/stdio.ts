import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { InterfaceDependencies } from "../dependencies.js";
import { createMcpServer } from "./index.js";

export async function startMcpStdio(
  deps: InterfaceDependencies,
): Promise<void> {
  const server = createMcpServer(deps);
  await server.connect(new StdioServerTransport());
}

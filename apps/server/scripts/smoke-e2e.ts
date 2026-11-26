#!/usr/bin/env node
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { and, eq, sql } from "drizzle-orm";
import type { AskResponse } from "../src/agent/index.js";
import type { IngestionJobView } from "../src/ingestion/index.js";
import type { SearchHit } from "../src/retrieval/index.js";
import { createAppRuntime } from "../src/runtime.js";
import {
  events,
  chunks,
  documents,
  ingestionJobs,
  sources,
} from "../src/storage/schema.js";

const REQUIRED_ENV = [
  "DATABASE_URL",
  "PARSER_WORKER_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "LLM_MODEL",
  "EMBEDDING_API_KEY",
  "EMBEDDING_BASE_URL",
  "EMBEDDING_MODEL",
  "RERANK_API_KEY",
  "RERANK_BASE_URL",
  "RERANK_MODEL",
] as const;

const REQUIRED_ENGINES = ["mineru_pdf", "deepseek_asr"] as const;

const PDF_QUESTION = "Which UDP port does the Aurora Beacon service listen on?";
const AUDIO_QUESTION = "When does the Aurora Beacon maintenance window start?";
const CODE_QUESTION = "What does auroraBeaconRetryBudget return?";
const HYPEREDGE_QUESTION =
  "How does Aurora Beacon connect the report, the audio note and the code?";
const OUT_OF_CORPUS_QUESTION = "What is the capital of France?";
const RG_QUERY = "AURORA_BEACON_CLUSTER";

const PDF_TITLE = "aurora-beacon-report.pdf";
const AUDIO_TITLE = "aurora-beacon-audio.wav";
const CODE_TITLE = "aurora-beacon.ts";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = requireFindUp(
  scriptDir,
  (directory) => existsSync(path.join(directory, "tsconfig.build.json")),
  "apps/server root",
);

interface EngineHealth {
  name: string;
  available: boolean;
  reason: string | null;
}

interface HealthResponse {
  status: string;
  engines: EngineHealth[];
}

interface RunningChild {
  child: ChildProcess;
  logs: string[];
}

interface VerifiedCitation {
  chunkId: string;
  title: string;
  anchor: SearchHit["anchor"];
}

type Anchor = SearchHit["anchor"];

const startedAt = Date.now();

await main();

async function main(): Promise<void> {
  loadDotEnv();
  const health = await preflight();
  const failures: string[] = [];

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "borges-smoke-"));
  const mirrorRoot = path.join(tempDir, "mirror");
  const sourceId = randomUUID();
  const runtimeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    MIRROR_ROOT: mirrorRoot,
    LOG_LEVEL: "warn",
  };
  const childEnv = childEnvironment({ MIRROR_ROOT: mirrorRoot });
  const runtime = createAppRuntime({ env: runtimeEnv });
  const db = runtime.database.db;
  const httpBin = path.join(
    packageRoot,
    "dist",
    "interfaces",
    "http",
    "bin.js",
  );
  const mcpBin = path.join(packageRoot, "dist", "interfaces", "mcp", "bin.js");
  const cliBin = path.join(packageRoot, "dist", "interfaces", "cli", "bin.js");
  let httpServer: RunningChild | null = null;
  let mcpClient: Client | null = null;
  let relevantScores: number[] = [];
  let irrelevantScores: number[] = [];

  console.log("=== Borges Phase 1 smoke-e2e ===");
  console.log(
    `preflight: ${REQUIRED_ENV.length} env vars, parser worker ok (${REQUIRED_ENGINES.join(", ")})`,
  );
  console.log(`sourceId: ${sourceId}`);
  console.log(`temp dir: ${tempDir}`);

  try {
    const ingestionOk = await attempt(
      failures,
      "1/5 real multimodal ingestion",
      async () => {
        const samples = await createSamples(tempDir);
        await db.insert(sources).values({
          id: sourceId,
          name: "smoke-e2e",
          extractHyperedge: true,
        });
        await ingestSamples(db, runtime.deps.ingestion, sourceId, samples);
      },
    );
    if (ingestionOk) {
      await attempt(
        failures,
        "2/5 retrieval and reranker scale probe",
        async () => {
          const probe = await probeRetrieval(runtime.deps.retrieval, sourceId);
          relevantScores = probe.relevantScores;
          irrelevantScores = probe.irrelevantScores;
        },
      );

      await attempt(
        failures,
        "3/5 real agent answers and refusals",
        async () => {
          await probeAgent(db, runtime.deps.agent, sourceId);
        },
      );

      await attempt(
        failures,
        "4/5 built HTTP, MCP stdio and CLI entries",
        async () => {
          const http = await startHttp(httpBin, childEnv);
          httpServer = http.running;
          mcpClient = await startMcp(mcpBin, childEnv);
          await compareEntryPoints({
            db,
            httpBaseUrl: `http://127.0.0.1:${http.port}`,
            mcpClient,
            cliBin,
            env: childEnv,
            sourceId,
          });
        },
      );
    }
  } finally {
    await attempt(failures, "5/5 cleanup", async () => {
      if (httpServer) {
        await stopChild(httpServer);
        httpServer = null;
      }
      if (mcpClient) {
        await closeMcp(mcpClient);
        mcpClient = null;
      }
      await db.delete(sources).where(eq(sources.id, sourceId));
      const remaining = await countSourceRows(db, sourceId);
      if (
        remaining.documents > 0 ||
        remaining.chunks > 0 ||
        remaining.events > 0 ||
        remaining.jobs > 0
      ) {
        throw new Error(
          `source rows remain after cascade delete: ${JSON.stringify(remaining)}`,
        );
      }
      await rm(tempDir, { recursive: true, force: true });
      if (existsSync(tempDir)) {
        throw new Error(`temp dir still exists: ${tempDir}`);
      }
      console.log(
        `  source ${sourceId} cascade-deleted; temp dir removed: ${tempDir}`,
      );
    });
    await runtime.close();
  }

  reportScores(health, relevantScores, irrelevantScores);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (failures.length > 0) {
    console.error(`\nSMOKE RESULT: FAIL (${elapsed}s)`);
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`\nSMOKE RESULT: PASS (${elapsed}s)`);
}

async function preflight(): Promise<HealthResponse> {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]?.trim());
  const problems = missing.map((name) => `missing env var: ${name}`);
  const workerUrl = (process.env.PARSER_WORKER_URL ?? "").replace(/\/+$/, "");
  let health: HealthResponse | null = null;
  if (workerUrl) {
    try {
      const response = await fetch(`${workerUrl}/health`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        problems.push(`parser worker health returned HTTP ${response.status}`);
      } else {
        const body = (await response.json()) as HealthResponse;
        health = body;
        if (body.status !== "ok") {
          problems.push(`parser worker status is ${body.status}`);
        }
        const engines = Array.isArray(body.engines) ? body.engines : [];
        for (const name of REQUIRED_ENGINES) {
          const engine = engines.find((entry) => entry.name === name);
          if (!engine) {
            problems.push(`parser worker is missing engine: ${name}`);
          } else if (!engine.available) {
            problems.push(
              `parser engine unavailable: ${name} (${engine.reason ?? "no reason"})`,
            );
          }
        }
      }
    } catch (error) {
      problems.push(`parser worker health check failed: ${messageOf(error)}`);
    }
  }
  if (problems.length > 0) {
    console.error("SMOKE PREFLIGHT FAILED");
    for (const problem of problems) {
      console.error(`- ${problem}`);
    }
    process.exit(1);
  }
  return health as HealthResponse;
}

async function createSamples(
  tempDir: string,
): Promise<{ pdf: string; wav: string; code: string }> {
  const pdf = path.join(tempDir, PDF_TITLE);
  const wav = path.join(tempDir, AUDIO_TITLE);
  const code = path.join(tempDir, CODE_TITLE);
  await writeFile(
    pdf,
    buildPdf([
      "Borges Phase One Smoke Report",
      "Aurora Beacon is the internal telemetry gateway.",
      "The Aurora Beacon service listens on UDP port 4721.",
    ]),
  );
  await synthesizeWav(
    wav,
    "The Aurora Beacon maintenance window starts at midnight.",
  );
  await writeFile(
    code,
    [
      'export const AURORA_BEACON_CLUSTER = "vector-9"; // Aurora Beacon cluster id',
      "",
      "export function auroraBeaconRetryBudget(): number {",
      "  return 3;",
      "}",
      "",
    ].join("\n"),
  );
  const wavDuration = wavDurationMs(readFileSync(wav));
  if (wavDuration <= 0 || wavDuration > 5_000) {
    throw new Error(
      `synthesized WAV must be at most 5 seconds, received ${wavDuration}ms`,
    );
  }
  console.log(
    `samples: ${PDF_TITLE}, ${AUDIO_TITLE} (${wavDuration}ms), ${CODE_TITLE}`,
  );
  return { pdf, wav, code };
}

async function ingestSamples(
  db: ReturnType<typeof createAppRuntime>["database"]["db"],
  ingestion: ReturnType<typeof createAppRuntime>["deps"]["ingestion"],
  sourceId: string,
  samples: { pdf: string; wav: string; code: string },
): Promise<void> {
  const inputs = [
    { title: PDF_TITLE, filePath: samples.pdf },
    { title: AUDIO_TITLE, filePath: samples.wav },
    { title: CODE_TITLE, filePath: samples.code },
  ];
  for (const input of inputs) {
    const started = Date.now();
    const job = await ingestion.submitDocument({
      sourceId,
      filePath: input.filePath,
      title: input.title,
    });
    const elapsedSeconds = (Date.now() - started) / 1000;
    const persisted = await ingestion.getJob(job.jobId);
    if (!persisted || persisted.status !== "READY") {
      throw new Error(
        `${input.title} did not reach READY: ${describeJob(persisted ?? job)}`,
      );
    }
    const documentId = persisted.documentId;
    if (!documentId) {
      throw new Error(`${input.title} is READY without a document id`);
    }
    const chunkCount = await countDocumentRows(db, "chunks", documentId);
    const eventCount = await countDocumentRows(db, "events", documentId);
    console.log(
      `  ${input.title}: job ${persisted.jobId} READY, chunks=${chunkCount}, events=${eventCount}, ${elapsedSeconds.toFixed(2)}s`,
    );
  }
}

async function probeRetrieval(
  retrieval: ReturnType<typeof createAppRuntime>["deps"]["retrieval"],
  sourceId: string,
): Promise<{ relevantScores: number[]; irrelevantScores: number[] }> {
  const relevant = await retrieval.search({
    query: PDF_QUESTION,
    sourceIds: [sourceId],
    mode: "hybrid",
    topK: 5,
  });
  console.log(`  hybrid in-corpus hits=${relevant.length}`);
  for (const hit of relevant) {
    console.log(`    ${describeHit(hit)}`);
  }
  if (relevant.length === 0) {
    throw new Error("hybrid in-corpus search returned no hits");
  }

  const irrelevant = await retrieval.search({
    query: OUT_OF_CORPUS_QUESTION,
    sourceIds: [sourceId],
    mode: "hybrid",
    topK: 5,
  });
  console.log(`  hybrid out-of-corpus hits=${irrelevant.length}`);
  for (const hit of irrelevant) {
    console.log(`    ${describeHit(hit)}`);
  }

  const hyperedge = await retrieval.search({
    query: HYPEREDGE_QUESTION,
    sourceIds: [sourceId],
    mode: "hyperedge",
    topK: 5,
  });
  console.log(`  hyperedge hits=${hyperedge.length}`);
  for (const hit of hyperedge) {
    console.log(`    ${describeHit(hit)}`);
  }
  if (hyperedge.length === 0) {
    throw new Error("hyperedge search returned no hits");
  }
  const hyperedgeDocuments = new Set(hyperedge.map((hit) => hit.documentId));
  if (hyperedgeDocuments.size < 2) {
    throw new Error(
      `hyperedge search reached ${hyperedgeDocuments.size} document(s), expected at least 2`,
    );
  }

  const rg = await retrieval.search({
    query: RG_QUERY,
    sourceIds: [sourceId],
    mode: "rg",
    topK: 5,
  });
  console.log(`  rg hits=${rg.length}`);
  for (const hit of rg) {
    console.log(`    ${describeHit(hit)}`);
  }
  if (rg.length === 0) {
    throw new Error(`rg search found no match for ${RG_QUERY}`);
  }

  if (!relevant.some((hit) => hit.content.includes("4721"))) {
    console.log(
      "  warning: no hybrid hit contains 4721; check MinerU extraction",
    );
  }

  return {
    relevantScores: relevant.map((hit) => hit.score),
    irrelevantScores: irrelevant.map((hit) => hit.score),
  };
}

async function probeAgent(
  db: Parameters<typeof verifyCitations>[0],
  agent: ReturnType<typeof createAppRuntime>["deps"]["agent"],
  sourceId: string,
): Promise<void> {
  const expectations = [
    {
      question: PDF_QUESTION,
      expectedTitle: PDF_TITLE,
      expectedKind: "page" as const,
    },
    {
      question: AUDIO_QUESTION,
      expectedTitle: AUDIO_TITLE,
      expectedKind: "time" as const,
    },
    {
      question: CODE_QUESTION,
      expectedTitle: CODE_TITLE,
      expectedKind: "line" as const,
    },
  ];
  for (const expectation of expectations) {
    const started = Date.now();
    const response = await agent.ask({
      query: expectation.question,
      sourceIds: [sourceId],
    });
    const elapsed = ((Date.now() - started) / 1000).toFixed(2);
    console.log(
      `  Q: ${expectation.question}\n    refused=${response.refused} citations=${response.citations.length} (${elapsed}s)\n    A: ${truncate(response.answer, 240)}`,
    );
    if (response.refused || response.citations.length === 0) {
      throw new Error(
        `agent refused or cited nothing for: ${expectation.question}`,
      );
    }
    const verified = await verifyCitations(db, response);
    for (const citation of verified) {
      console.log(
        `    citation ${citation.chunkId} title=${citation.title} anchor=${formatAnchor(citation.anchor)}`,
      );
    }
    const anchored = verified.some(
      (citation) =>
        citation.title === expectation.expectedTitle &&
        citation.anchor.kind === expectation.expectedKind,
    );
    if (!anchored) {
      throw new Error(
        `agent answer for "${expectation.question}" has no verified ${expectation.expectedKind} citation from ${expectation.expectedTitle}`,
      );
    }
  }

  const started = Date.now();
  const refusal = await agent.ask({
    query: OUT_OF_CORPUS_QUESTION,
    sourceIds: [sourceId],
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(2);
  console.log(
    `  Q: ${OUT_OF_CORPUS_QUESTION}\n    refused=${refusal.refused} citations=${refusal.citations.length} (${elapsed}s)\n    A: ${truncate(refusal.answer, 240)}`,
  );
  if (!refusal.refused || refusal.citations.length !== 0) {
    throw new Error(
      `out-of-corpus question must be refused without citations, got refused=${refusal.refused} citations=${refusal.citations.length}`,
    );
  }
}

async function compareEntryPoints(input: {
  db: Parameters<typeof verifyCitations>[0];
  httpBaseUrl: string;
  mcpClient: Client;
  cliBin: string;
  env: NodeJS.ProcessEnv;
  sourceId: string;
}): Promise<void> {
  const askBody = {
    query: PDF_QUESTION,
    sourceIds: [input.sourceId],
  };

  const httpResponse = await fetch(`${input.httpBaseUrl}/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(askBody),
  });
  if (!httpResponse.ok) {
    throw new Error(
      `HTTP /ask returned ${httpResponse.status}: ${truncate(await httpResponse.text(), 500)}`,
    );
  }
  const httpAsk = parseAskResponse(await httpResponse.json(), "HTTP /ask");
  console.log(
    `  HTTP /ask refused=${httpAsk.refused} citations=${httpAsk.citations.length}`,
  );

  const mcpResult = (await input.mcpClient.callTool({
    name: "ask",
    arguments: askBody,
  })) as {
    content?: { type: string; text?: string }[];
    isError?: boolean;
  };
  const mcpContent = mcpResult.content?.[0];
  if (mcpResult.isError || !mcpContent || mcpContent.type !== "text") {
    throw new Error(`MCP ask failed: ${mcpContent?.text ?? "no text content"}`);
  }
  const mcpAsk = parseAskResponse(
    JSON.parse(mcpContent.text ?? "null"),
    "MCP ask",
  );
  console.log(
    `  MCP ask refused=${mcpAsk.refused} citations=${mcpAsk.citations.length}`,
  );

  const cliJson = await runProcess(
    process.execPath,
    [
      input.cliBin,
      "ask",
      "--query",
      askBody.query,
      "--source-id",
      input.sourceId,
      "--format",
      "json",
    ],
    input.env,
    240_000,
  );
  const envelope = JSON.parse(cliJson) as {
    ok?: boolean;
    data?: unknown;
    error?: { code?: string; message?: string };
  };
  if (envelope.ok !== true) {
    throw new Error(
      `CLI ask failed: ${JSON.stringify(envelope.error ?? envelope)}`,
    );
  }
  const cliAsk = parseAskResponse(envelope.data, "CLI ask");
  console.log(
    `  CLI ask (json) refused=${cliAsk.refused} citations=${cliAsk.citations.length}`,
  );

  await verifyCitations(input.db, httpAsk);
  await verifyCitations(input.db, mcpAsk);
  await verifyCitations(input.db, cliAsk);

  const httpIds = citationIds(httpAsk);
  const mcpIds = citationIds(mcpAsk);
  const cliIds = citationIds(cliAsk);
  if (
    httpAsk.refused !== mcpAsk.refused ||
    httpAsk.refused !== cliAsk.refused ||
    httpIds.join(",") !== mcpIds.join(",") ||
    httpIds.join(",") !== cliIds.join(",")
  ) {
    throw new Error(
      `entry points disagreed: http=[${httpIds.join(",")}], mcp=[${mcpIds.join(",")}], cli=[${cliIds.join(",")}]`,
    );
  }
  console.log(
    `  entry points agree: refused=${httpAsk.refused}, citations=[${httpIds.join(",")}]`,
  );

  const cliText = await runProcess(
    process.execPath,
    [
      input.cliBin,
      "ask",
      "--query",
      askBody.query,
      "--source-id",
      input.sourceId,
      "--format",
      "text",
    ],
    input.env,
    240_000,
  );
  if (!/Citations:|Refused:/.test(cliText)) {
    throw new Error(
      `CLI text output is missing answer or refusal sections: ${truncate(cliText, 300)}`,
    );
  }
  console.log("  CLI ask (text) rendered answer or refusal");
}

async function startHttp(
  binPath: string,
  env: NodeJS.ProcessEnv,
): Promise<{ running: RunningChild; port: number }> {
  ensureBuilt(binPath);
  const port = await freePort();
  const running = startChild(process.execPath, [binPath], {
    ...env,
    PORT: String(port),
    HOST: "127.0.0.1",
  });
  await waitForHttpHealth(`http://127.0.0.1:${port}/health`, running, 30_000);
  console.log(`  HTTP server listening on 127.0.0.1:${port}`);
  return { running, port };
}

async function startMcp(
  binPath: string,
  env: NodeJS.ProcessEnv,
): Promise<Client> {
  ensureBuilt(binPath);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [binPath],
    cwd: packageRoot,
    env: env as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "borges-smoke", version: "0.0.0" });
  await client.connect(transport);
  transport.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
  });
  console.log("  MCP stdio server connected");
  return client;
}

async function closeMcp(client: Client): Promise<void> {
  await client.close().catch(() => undefined);
}

async function verifyCitations(
  db: ReturnType<typeof createAppRuntime>["database"]["db"],
  response: AskResponse,
): Promise<VerifiedCitation[]> {
  const verified: VerifiedCitation[] = [];
  for (const citation of response.citations) {
    const [row] = await db
      .select({
        sourceId: chunks.sourceId,
        title: documents.title,
        anchor: chunks.anchor,
      })
      .from(chunks)
      .innerJoin(documents, eq(chunks.documentId, documents.id))
      .where(eq(chunks.id, citation.chunkId))
      .limit(1);
    if (!row) {
      throw new Error(
        `citation ${citation.chunkId} does not exist in the database`,
      );
    }
    if (row.sourceId !== citation.sourceId) {
      throw new Error(
        `citation ${citation.chunkId} sourceId ${citation.sourceId} does not match database ${row.sourceId}`,
      );
    }
    if (JSON.stringify(row.anchor) !== JSON.stringify(citation.anchor)) {
      throw new Error(
        `citation ${citation.chunkId} anchor mismatch: ${JSON.stringify(citation.anchor)} vs ${JSON.stringify(row.anchor)}`,
      );
    }
    const expectedKind = expectedAnchorKind(row.title);
    if (citation.anchor.kind !== expectedKind) {
      throw new Error(
        `citation ${citation.chunkId} from ${row.title} has ${citation.anchor.kind} anchor, expected ${expectedKind}`,
      );
    }
    verified.push({
      chunkId: citation.chunkId,
      title: row.title,
      anchor: citation.anchor,
    });
  }
  return verified;
}

function expectedAnchorKind(title: string): Anchor["kind"] {
  const lower = title.toLowerCase();
  if (lower.endsWith(".pdf")) {
    return "page";
  }
  if (/\.(wav|mp3|ogg|opus)$/.test(lower)) {
    return "time";
  }
  return "line";
}

function reportScores(
  health: HealthResponse,
  relevantScores: number[],
  irrelevantScores: number[],
): void {
  console.log("\n=== reranker scale probe ===");
  console.log(
    `  engines: ${health.engines.map((engine) => `${engine.name}=${engine.available}`).join(", ")}`,
  );
  const threshold = Number(process.env.AGENT_REFUSAL_THRESHOLD ?? "0.2");
  if (relevantScores.length === 0) {
    console.log("  relevant hits: none (retrieval step did not record scores)");
    return;
  }
  const relevantMin = Math.min(...relevantScores);
  const relevantMax = Math.max(...relevantScores);
  const irrelevantMax =
    irrelevantScores.length === 0 ? 0 : Math.max(...irrelevantScores);
  const midpoint =
    Math.round(((relevantMax + irrelevantMax) / 2) * 1000) / 1000;
  const floor = Math.round((irrelevantMax + 0.01) * 1000) / 1000;
  console.log(
    `  in-corpus hybrid candidate scores: [${relevantMin.toFixed(4)}, ${relevantMax.toFixed(4)}] (low tail is unrelated candidates, expected)`,
  );
  console.log(`  best in-corpus score: ${relevantMax.toFixed(4)}`);
  console.log(`  out-of-corpus hits max score: ${irrelevantMax.toFixed(4)}`);
  console.log(`  AGENT_REFUSAL_THRESHOLD=${threshold}`);
  if (relevantMax > irrelevantMax) {
    console.log(
      `  suggestion: above ${floor} excludes every out-of-corpus hit; midpoint ${midpoint}; current ${threshold} ${threshold > irrelevantMax ? "already excludes them" : "does not exclude them"}`,
    );
  } else {
    console.log(
      "  suggestion: none; the best in-corpus score does not clear out-of-corpus, review the reranker scale",
    );
  }
}

function describeJob(job: IngestionJobView | null): string {
  if (!job) {
    return "job not found";
  }
  return `${job.status} code=${job.errorCode ?? "none"} message=${truncate(job.errorMessage ?? "-", 300)}`;
}

function describeHit(hit: SearchHit): string {
  return `${hit.chunkId} doc=${hit.documentId} score=${hit.score.toFixed(4)} anchor=${formatAnchor(hit.anchor)}`;
}

function formatAnchor(anchor: Anchor): string {
  switch (anchor.kind) {
    case "page":
      return `page ${anchor.pageNumber}${anchor.sectionPath.length > 0 ? ` (${anchor.sectionPath.join(" > ")})` : ""}`;
    case "time":
      return `${formatMs(anchor.startMs)}-${formatMs(anchor.endMs)}ms`;
    case "line":
      return `${anchor.filePath}:${anchor.startLine}-${anchor.endLine}`;
  }
}

function formatMs(value: number): string {
  return value.toString();
}

async function countDocumentRows(
  db: ReturnType<typeof createAppRuntime>["database"]["db"],
  table: "chunks" | "events",
  documentId: string,
): Promise<number> {
  const [row] =
    table === "chunks"
      ? await db
          .select({ count: sql<number>`count(*)::int` })
          .from(chunks)
          .where(
            and(eq(chunks.documentId, documentId), eq(chunks.isActive, true)),
          )
      : await db
          .select({ count: sql<number>`count(*)::int` })
          .from(events)
          .where(
            and(eq(events.documentId, documentId), eq(events.isActive, true)),
          );
  return row?.count ?? 0;
}

async function countSourceRows(
  db: ReturnType<typeof createAppRuntime>["database"]["db"],
  sourceId: string,
): Promise<{
  documents: number;
  chunks: number;
  events: number;
  jobs: number;
}> {
  const [documentRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(documents)
    .where(eq(documents.sourceId, sourceId));
  const [chunkRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(chunks)
    .where(eq(chunks.sourceId, sourceId));
  const [eventRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(events)
    .where(eq(events.sourceId, sourceId));
  const [jobRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(ingestionJobs)
    .where(eq(ingestionJobs.sourceId, sourceId));
  return {
    documents: documentRow?.count ?? 0,
    chunks: chunkRow?.count ?? 0,
    events: eventRow?.count ?? 0,
    jobs: jobRow?.count ?? 0,
  };
}

function buildPdf(lines: readonly string[]): Buffer {
  const content = lines
    .map((line, index) => {
      const size = index === 0 ? 18 : 12;
      const y = 760 - index * 28;
      return `BT /F1 ${size} Tf 72 ${y} Td (${escapePdfText(line)}) Tj ET`;
    })
    .join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "utf8")} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

function escapePdfText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

async function synthesizeWav(target: string, sentence: string): Promise<void> {
  const windowsPath = target.split(path.sep).join("/");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Speech",
    "$synthesizer = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    `$synthesizer.SetOutputToWaveFile('${windowsPath.replace(/'/g, "''")}')`,
    `$synthesizer.Speak('${sentence.replace(/'/g, "''")}')`,
    "$synthesizer.Dispose()",
  ].join("; ");
  await runProcess(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    process.env,
    120_000,
  );
}

function wavDurationMs(buffer: Buffer): number {
  if (
    buffer.length < 44 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("synthesized audio is not a RIFF/WAVE file");
  }
  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "fmt " && offset + 20 <= buffer.length) {
      byteRate = buffer.readUInt32LE(offset + 16);
    }
    if (id === "data") {
      dataSize = Math.min(size, buffer.length - offset - 8);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (byteRate <= 0 || dataSize <= 0) {
    throw new Error("synthesized WAV is missing fmt or data chunks");
  }
  return Math.round((dataSize / byteRate) * 1000);
}

function startChild(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): RunningChild {
  const child = spawn(file, args, {
    cwd: packageRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const logs: string[] = [];
  const collect = (chunk: Buffer) => {
    logs.push(chunk.toString("utf8"));
    if (logs.length > 200) {
      logs.shift();
    }
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  return { child, logs };
}

async function waitForHttpHealth(
  url: string,
  running: RunningChild,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (running.child.exitCode !== null) {
      throw new Error(
        `server exited with code ${running.child.exitCode}: ${truncate(running.logs.join(""), 1000)}`,
      );
    }
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // not ready yet
    }
    await delay(200);
  }
  throw new Error(
    `server did not become healthy at ${url}: ${truncate(running.logs.join(""), 1000)}`,
  );
}

async function stopChild(running: RunningChild): Promise<void> {
  if (running.child.exitCode !== null) {
    return;
  }
  running.child.kill();
  if (!(await waitForChildExit(running.child, 8_000))) {
    running.child.kill("SIGKILL");
    await waitForChildExit(running.child, 5_000);
  }
}

function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

function runProcess(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd: packageRoot,
        env,
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${file} ${args.join(" ")} failed: ${messageOf(error)}; stderr=${truncate(stderr, 800)}; stdout=${truncate(stdout, 800)}`,
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || !address) {
        server.close();
        reject(new Error("failed to allocate a free port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function parseAskResponse(value: unknown, label: string): AskResponse {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} did not return an object`);
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.answer !== "string" ||
    typeof record.refused !== "boolean" ||
    !Array.isArray(record.citations)
  ) {
    throw new Error(`${label} returned an invalid AskResponse`);
  }
  return value as AskResponse;
}

function citationIds(response: AskResponse): string[] {
  return response.citations.map((citation) => citation.chunkId).sort();
}

async function attempt(
  failures: string[],
  label: string,
  work: () => Promise<void>,
): Promise<boolean> {
  try {
    await work();
    console.log(`PASS ${label}`);
    return true;
  } catch (error) {
    const message = messageOf(error);
    failures.push(`${label}: ${message}`);
    console.log(`FAIL ${label}: ${message}`);
    return false;
  }
}

function ensureBuilt(binPath: string): void {
  if (!existsSync(binPath)) {
    throw new Error(
      `build output is missing: ${binPath}; run pnpm --filter @borges/server run build`,
    );
  }
}

function childEnvironment(
  overrides: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return { ...env, ...overrides };
}

function loadDotEnv(): void {
  const envDir = findUp(process.cwd(), (directory) =>
    existsSync(path.join(directory, ".env")),
  );
  if (!envDir) {
    return;
  }
  const content = readFileSync(path.join(envDir, ".env"), "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
      line,
    );
    const name = match?.[1];
    const rawValue = match?.[2];
    if (!name || rawValue === undefined) {
      continue;
    }
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[name] === undefined) {
      process.env[name] = value;
    }
  }
}

function findUp(
  start: string,
  predicate: (directory: string) => boolean,
): string | null {
  let current = path.resolve(start);
  while (true) {
    if (predicate(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function requireFindUp(
  start: string,
  predicate: (directory: string) => boolean,
  label: string,
): string {
  const result = findUp(start, predicate);
  if (!result) {
    throw new Error(`could not locate ${label} above ${start}`);
  }
  return result;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}...`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

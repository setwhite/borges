import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import type { DbClient } from "../storage/db.js";
import { RetrievalError, toRetrievalError } from "./errors.js";
import type { ChunkRow, SearchHit } from "./hit.js";
import { type SearchScope, scopePredicate } from "./prefilter.js";

const RG_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const RG_OPTIONS = [
  "--json",
  "--hidden",
  "--no-ignore",
  "--line-number",
  "--no-messages",
];

interface RgSearchInput {
  db: DbClient;
  scope: SearchScope;
  mirrorRoot: string;
  query: string;
  topK: number;
  rgPath: string;
  timeoutMs: number;
}

interface SearchDirectory {
  sourceId: string;
  directory: string;
}

interface RgMatch {
  filePath: string;
  line: number;
}

interface LineChunk {
  chunkId: string;
  documentId: string;
  sourceId: string;
  content: string;
  startLine: number;
  endLine: number;
}

interface ScoredHit {
  hit: SearchHit;
  directoryOrder: number;
  filePath: string;
  line: number;
}

type LineChunkIndex = Map<string, Map<string, LineChunk[]>>;

export async function rgSearch(input: RgSearchInput): Promise<SearchHit[]> {
  const directories = await resolveSearchDirectories(
    input.mirrorRoot,
    input.scope.sourceIds,
  );
  if (directories.length === 0) {
    return [];
  }
  let index: LineChunkIndex;
  try {
    index = await loadLineChunks(input.db, input.scope);
  } catch (error) {
    throw toRetrievalError(error, "rg_failed", "rg");
  }
  const collected: ScoredHit[] = [];
  const seenChunkIds = new Set<string>();
  for (const [directoryOrder, entry] of directories.entries()) {
    const chunksByFilePath = index.get(entry.sourceId);
    if (!chunksByFilePath) {
      continue;
    }
    const matches = await runRipgrep(input, entry.directory);
    for (const match of matches) {
      const chunk = findChunkForLine(
        chunksByFilePath.get(match.filePath),
        match.line,
      );
      if (!chunk || seenChunkIds.has(chunk.chunkId)) {
        continue;
      }
      seenChunkIds.add(chunk.chunkId);
      collected.push({
        directoryOrder,
        filePath: match.filePath,
        line: match.line,
        hit: {
          chunkId: chunk.chunkId,
          documentId: chunk.documentId,
          sourceId: chunk.sourceId,
          content: chunk.content,
          score: 1,
          anchor: {
            kind: "line",
            filePath: match.filePath,
            startLine: match.line,
            endLine: match.line,
          },
        },
      });
    }
  }
  return collected
    .sort(
      (left, right) =>
        left.directoryOrder - right.directoryOrder ||
        left.filePath.localeCompare(right.filePath) ||
        left.line - right.line,
    )
    .slice(0, input.topK)
    .map((entry) => entry.hit);
}

async function resolveSearchDirectories(
  mirrorRoot: string,
  sourceIds: string[],
): Promise<SearchDirectory[]> {
  const root = await realpathOrNull(mirrorRoot);
  if (!root || !(await isDirectory(root))) {
    return [];
  }
  const directories: SearchDirectory[] = [];
  for (const sourceId of sourceIds) {
    assertSinglePathSegment(sourceId);
    assertInsideRoot(root, path.resolve(root, sourceId), sourceId);
    const resolved = await realpathOrNull(path.resolve(root, sourceId));
    if (!resolved) {
      continue;
    }
    assertInsideRoot(root, resolved, sourceId);
    if (!(await isDirectory(resolved))) {
      continue;
    }
    directories.push({ sourceId, directory: resolved });
  }
  return directories;
}

function assertSinglePathSegment(sourceId: string): void {
  if (
    sourceId.length === 0 ||
    sourceId === "." ||
    sourceId === ".." ||
    path.basename(sourceId) !== sourceId
  ) {
    throw new RetrievalError(
      "rg_sandbox_escape",
      "rg",
      `source id must be a single path segment: ${sourceId}`,
    );
  }
}

function assertInsideRoot(
  root: string,
  target: string,
  sourceId: string,
): void {
  const relative = path.relative(root, target);
  if (
    relative.length === 0 ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new RetrievalError(
      "rg_sandbox_escape",
      "rg",
      `mirror path escapes the mirror root: ${sourceId}`,
    );
  }
}

async function loadLineChunks(
  db: DbClient,
  scope: SearchScope,
): Promise<LineChunkIndex> {
  const result = await db.execute<ChunkRow>(sql`
    select c.id as chunk_id, c.document_id, c.source_id, c.content, c.anchor
    from chunks c
    where ${scopePredicate("c", scope)}
      and ${sql.raw("c.anchor ->> 'kind'")} = ${"line"}
  `);
  const index: LineChunkIndex = new Map();
  for (const row of result.rows) {
    const anchor = row.anchor;
    if (anchor.kind !== "line") {
      continue;
    }
    const filePath = normalizeRelativePath(anchor.filePath);
    const chunksByFilePath = index.get(row.source_id) ?? new Map();
    const chunks = chunksByFilePath.get(filePath) ?? [];
    chunks.push({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      sourceId: row.source_id,
      content: row.content,
      startLine: anchor.startLine,
      endLine: anchor.endLine,
    });
    chunksByFilePath.set(filePath, chunks);
    index.set(row.source_id, chunksByFilePath);
  }
  for (const chunksByFilePath of index.values()) {
    for (const chunks of chunksByFilePath.values()) {
      chunks.sort(
        (left, right) =>
          left.startLine - right.startLine || left.endLine - right.endLine,
      );
    }
  }
  return index;
}

async function runRipgrep(
  input: RgSearchInput,
  directory: string,
): Promise<RgMatch[]> {
  let stdout: string;
  try {
    stdout = await execRipgrep(input, directory);
  } catch (error) {
    if (isNoMatchExit(error)) {
      return [];
    }
    throw rgFailure(error, input.query);
  }
  return parseRgJson(stdout, input.query);
}

function execRipgrep(input: RgSearchInput, directory: string): Promise<string> {
  const args = [...RG_OPTIONS, "--", input.query, "."];
  return new Promise((resolve, reject) => {
    execFile(
      input.rgPath,
      args,
      {
        cwd: directory,
        timeout: input.timeoutMs,
        maxBuffer: RG_MAX_BUFFER_BYTES,
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new RipgrepFailure(error, stderr));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

class RipgrepFailure extends Error {
  readonly code: unknown;
  readonly stderr: string;
  readonly killed: boolean;
  readonly signal: NodeJS.Signals | null;

  constructor(cause: Error, stderr: string) {
    super(cause.message, { cause });
    const details = cause as {
      code?: unknown;
      killed?: boolean;
      signal?: NodeJS.Signals | null;
    };
    this.code = details.code;
    this.killed = details.killed ?? false;
    this.signal = details.signal ?? null;
    this.stderr = stderr;
  }
}

function parseRgJson(stdout: string, query: string): RgMatch[] {
  const matches: RgMatch[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    const event = parseRgEvent(line, query);
    if (!event) {
      continue;
    }
    const lineNumber = event.data.line_number;
    if (
      typeof lineNumber !== "number" ||
      !Number.isInteger(lineNumber) ||
      lineNumber < 1
    ) {
      continue;
    }
    matches.push({
      filePath: normalizeRelativePath(event.data.path.text),
      line: lineNumber,
    });
  }
  return matches;
}

interface RgMatchEvent {
  type: "match";
  data: { path: { text: string }; line_number?: number | null };
}

function parseRgEvent(line: string, query: string): RgMatchEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new RetrievalError(
      "rg_failed",
      "rg",
      `ripgrep emitted invalid JSON for query ${JSON.stringify(query)}`,
      { cause: error },
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const event = parsed as {
    type?: unknown;
    data?: { path?: { text?: unknown } };
  };
  // ripgrep reports non-UTF-8 paths as base64 bytes; those cannot be mapped back
  // to chunk anchors, so they are not hits.
  if (event.type !== "match" || typeof event.data?.path?.text !== "string") {
    return null;
  }
  return parsed as RgMatchEvent;
}

function rgFailure(error: unknown, query: string): RetrievalError {
  if (!(error instanceof RipgrepFailure)) {
    const message = error instanceof Error ? error.message : String(error);
    return new RetrievalError("rg_failed", "rg", message, { cause: error });
  }
  if (error.code === "ENOENT") {
    return new RetrievalError(
      "rg_unavailable",
      "rg",
      "ripgrep executable was not found; install ripgrep or set the rg path",
      { cause: error },
    );
  }
  if (error.killed || error.signal === "SIGTERM") {
    return new RetrievalError(
      "rg_timeout",
      "rg",
      `ripgrep timed out for query ${JSON.stringify(query)}`,
      { cause: error },
    );
  }
  const stderr = error.stderr.trim();
  if (
    error.code === 2 &&
    /regex parse error|error parsing flag/i.test(stderr)
  ) {
    return new RetrievalError(
      "rg_invalid_pattern",
      "rg",
      `ripgrep rejected the pattern ${JSON.stringify(query)}: ${stderr.slice(0, 500)}`,
      { cause: error },
    );
  }
  return new RetrievalError(
    "rg_failed",
    "rg",
    `ripgrep exited with code ${String(error.code)}${stderr ? `: ${stderr.slice(0, 500)}` : ""}`,
    { cause: error },
  );
}

function isNoMatchExit(error: unknown): boolean {
  return error instanceof RipgrepFailure && error.code === 1;
}

function findChunkForLine(
  chunks: LineChunk[] | undefined,
  line: number,
): LineChunk | null {
  if (!chunks) {
    return null;
  }
  for (const chunk of chunks) {
    if (chunk.startLine <= line && line <= chunk.endLine) {
      return chunk;
    }
  }
  return null;
}

function normalizeRelativePath(value: string): string {
  return value
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join("/");
}

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await realpath(target);
  } catch (error) {
    if (isMissingPath(error)) {
      return null;
    }
    throw error;
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch (error) {
    if (isMissingPath(error)) {
      return false;
    }
    throw error;
  }
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "ENOENT"
  );
}

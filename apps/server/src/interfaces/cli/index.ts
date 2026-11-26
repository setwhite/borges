import { Command, CommanderError, InvalidArgumentError } from "commander";
import type { AskRequest } from "../../agent/index.js";
import type {
  SourceFilter,
  SubmitDocumentInput,
} from "../../ingestion/index.js";
import type { RetrievalMode } from "../../retrieval/index.js";
import type { InterfaceDependencies } from "../dependencies.js";
import { toInterfaceError } from "../errors.js";
import {
  DEFAULT_TOP_K,
  MAX_TOP_K,
  MIN_TOP_K,
  buildSearchRequest,
  isValidTopK,
} from "../searchRequest.js";
import { renderAsk, renderHits, renderJob, renderSources } from "./text.js";

const EXIT_DOMAIN_ERROR = 1;
const EXIT_USAGE_ERROR = 2;
const RETRIEVAL_MODES: readonly RetrievalMode[] = ["hybrid", "hyperedge", "rg"];

export type OutputFormat = "json" | "text";

export interface CliIO {
  stdout(text: string): void;
}

export interface Cli {
  run(argv: string[]): Promise<number>;
}

interface FormatOptions {
  format: OutputFormat;
}

interface SourcesListOptions extends FormatOptions {
  tenantId?: string;
  aclTag?: string[];
}

interface IngestOptions extends FormatOptions {
  sourceId: string;
  file: string;
  title?: string;
  tenantId?: string;
  aclTag?: string[];
}

interface SearchOptions extends FormatOptions {
  query: string;
  sourceId?: string[];
  mode: RetrievalMode;
  topK: number;
  tenantId?: string;
  aclTag?: string[];
}

interface AskOptions extends FormatOptions {
  query: string;
  sourceId?: string[];
  tenantId?: string;
  aclTag?: string[];
}

export function createCli(
  deps: InterfaceDependencies,
  io: Partial<CliIO> = {},
): Cli {
  const write = io.stdout ?? ((text: string) => process.stdout.write(text));
  return {
    run: async (argv) => {
      const program = buildProgram(deps, write);
      try {
        await program.parseAsync(argv, { from: "user" });
        return 0;
      } catch (error) {
        if (error instanceof CommanderError) {
          if (
            error.code === "commander.helpDisplayed" ||
            error.code === "commander.version"
          ) {
            return 0;
          }
          writeEnvelope(write, {
            ok: false,
            error: {
              code: commanderErrorCode(error),
              message: error.message,
            },
          });
          return error.exitCode || EXIT_USAGE_ERROR;
        }
        const mapped = toInterfaceError(error);
        writeEnvelope(write, {
          ok: false,
          error: { code: mapped.code, message: mapped.message },
        });
        return EXIT_DOMAIN_ERROR;
      }
    },
  };
}

function buildProgram(
  deps: InterfaceDependencies,
  write: (text: string) => void,
): Command {
  const program = new Command();
  program
    .name("borges")
    .description("Agent-first knowledge base CLI")
    .version("0.1.0")
    .exitOverride()
    .showHelpAfterError(false)
    .configureOutput({
      writeOut: (text) => write(text),
      writeErr: () => {},
    });

  program
    .command("sources")
    .description("Inspect knowledge base sources")
    .command("list")
    .description("List visible sources")
    .option("--tenant-id <tenantId>", "tenant scope")
    .option("--acl-tag <aclTag>", "ACL tag filter", collect, [])
    .option(
      "--format <format>",
      "output format: json or text",
      parseFormat,
      "json",
    )
    .action(async (options: SourcesListOptions) => {
      const sources = await deps.ingestion.listSources(
        sourceFilter(options.tenantId, options.aclTag),
      );
      emit(write, options.format, sources, () => renderSources(sources));
    });

  program
    .command("ingest")
    .description("Submit a document to a source")
    .option("--source-id <sourceId>", "target source id")
    .option("--file <filePath>", "path of the file to ingest")
    .option("--title <title>", "document title override")
    .option("--tenant-id <tenantId>", "tenant scope")
    .option("--acl-tag <aclTag>", "ACL tag override", collect, [])
    .option(
      "--format <format>",
      "output format: json or text",
      parseFormat,
      "json",
    )
    .action(async (options: IngestOptions) => {
      const input = submitDocumentInput(options);
      const job = await deps.ingestion.submitDocument(input);
      emit(write, options.format, job, () => renderJob(job));
    });

  program
    .command("search")
    .description("Search chunks across retrieval modes")
    .option("--query <query>", "search query")
    .option("--source-id <sourceId>", "source id to search", collect, [])
    .option(
      "--mode <mode>",
      "retrieval mode: hybrid, hyperedge or rg",
      parseMode,
      "hybrid",
    )
    .option(
      "--top-k <topK>",
      "maximum hits to return",
      parseTopK,
      DEFAULT_TOP_K,
    )
    .option("--tenant-id <tenantId>", "tenant scope")
    .option("--acl-tag <aclTag>", "ACL tag filter", collect, [])
    .option(
      "--format <format>",
      "output format: json or text",
      parseFormat,
      "json",
    )
    .action(async (options: SearchOptions) => {
      const hits = await deps.retrieval.search(searchRequest(options));
      emit(write, options.format, hits, () => renderHits(hits));
    });

  program
    .command("ask")
    .description("Answer a question with verified citations")
    .option("--query <query>", "question to answer")
    .option("--source-id <sourceId>", "source id to search", collect, [])
    .option("--tenant-id <tenantId>", "tenant scope")
    .option("--acl-tag <aclTag>", "ACL tag filter", collect, [])
    .option(
      "--format <format>",
      "output format: json or text",
      parseFormat,
      "json",
    )
    .action(async (options: AskOptions) => {
      const request = askRequest(options);
      const response = await deps.agent.ask(request);
      emit(write, options.format, response, () => renderAsk(response));
    });

  return program;
}

function emit(
  write: (text: string) => void,
  format: OutputFormat,
  data: unknown,
  renderText: () => string,
): void {
  if (format === "text") {
    write(`${renderText()}\n`);
    return;
  }
  writeEnvelope(write, { ok: true, data });
}

function writeEnvelope(write: (text: string) => void, payload: unknown): void {
  write(`${JSON.stringify(payload, null, 2)}\n`);
}

function sourceFilter(
  tenantId: string | undefined,
  aclTags: readonly string[] | undefined,
): SourceFilter {
  return {
    ...(tenantId === undefined ? {} : { tenantId }),
    ...(aclTags === undefined ? {} : { aclTags: [...aclTags] }),
  };
}

function submitDocumentInput(options: IngestOptions): SubmitDocumentInput {
  const aclTags = options.aclTag ?? [];
  return {
    sourceId: requireOption(options.sourceId, "--source-id"),
    filePath: requireOption(options.file, "--file"),
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
    ...(aclTags.length === 0 ? {} : { aclTags }),
  };
}

function searchRequest(options: SearchOptions) {
  const aclTags = options.aclTag ?? [];
  return buildSearchRequest({
    query: requireOption(options.query, "--query"),
    sourceIds: requireSourceIds(options.sourceId),
    mode: options.mode,
    topK: options.topK,
    ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
    ...(aclTags.length === 0 ? {} : { aclTags }),
  });
}

function askRequest(options: AskOptions): AskRequest {
  return {
    query: requireOption(options.query, "--query"),
    sourceIds: requireSourceIds(options.sourceId),
    ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
    ...(options.aclTag === undefined || options.aclTag.length === 0
      ? {}
      : { aclTags: [...options.aclTag] }),
  };
}

function requireOption(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new InvalidArgumentError(`required option ${name} not specified`);
  }
  return value;
}

function requireSourceIds(values: readonly string[] | undefined): string[] {
  if (!values || values.length === 0) {
    throw new InvalidArgumentError("required option --source-id not specified");
  }
  return [...values];
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseFormat(value: string): OutputFormat {
  if (value === "json" || value === "text") {
    return value;
  }
  throw new InvalidArgumentError("format must be json or text");
}

function parseMode(value: string): RetrievalMode {
  if (RETRIEVAL_MODES.includes(value as RetrievalMode)) {
    return value as RetrievalMode;
  }
  throw new InvalidArgumentError(
    `mode must be one of: ${RETRIEVAL_MODES.join(", ")}`,
  );
}

function parseTopK(value: string): number {
  const parsed = Number(value);
  if (!isValidTopK(parsed)) {
    throw new InvalidArgumentError(
      `top-k must be an integer between ${MIN_TOP_K} and ${MAX_TOP_K}`,
    );
  }
  return parsed;
}

function commanderErrorCode(error: CommanderError): string {
  return error.code === "commander.unknownCommand"
    ? "unknown_command"
    : "invalid_request";
}

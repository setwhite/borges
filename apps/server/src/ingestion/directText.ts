import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { EvidenceIR } from "../contracts/evidence-ir.js";
import { IngestionFailure } from "./failures.js";

export const DIRECT_TEXT_PARSER_ENGINE = "direct-text";

const TEXT_MEDIA_TYPES = new Map<string, string>([
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".markdown", "text/markdown"],
  [".ts", "text/typescript"],
  [".tsx", "text/tsx"],
  [".js", "application/javascript"],
  [".jsx", "text/jsx"],
  [".mjs", "application/javascript"],
  [".cjs", "application/javascript"],
  [".py", "text/x-python"],
  [".json", "application/json"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
  [".sql", "application/sql"],
  [".toml", "application/toml"],
  [".sh", "text/x-shellscript"],
]);

const COMPLEX_MEDIA_TYPES = new Map<string, string>([
  [".pdf", "application/pdf"],
  [".wav", "audio/wav"],
  [".ogg", "audio/ogg"],
  [".opus", "audio/opus"],
]);

export type SourceFormat =
  | { kind: "text"; mediaType: string }
  | { kind: "parser"; mediaType: string }
  | { kind: "unsupported" };

export function resolveSourceFormat(filePath: string): SourceFormat {
  const extension = extname(filePath).toLowerCase();
  const textMediaType = TEXT_MEDIA_TYPES.get(extension);
  if (textMediaType) {
    return { kind: "text", mediaType: textMediaType };
  }
  const complexMediaType = COMPLEX_MEDIA_TYPES.get(extension);
  if (complexMediaType) {
    return { kind: "parser", mediaType: complexMediaType };
  }
  return { kind: "unsupported" };
}

interface DirectTextEvidenceInput {
  filePath: string;
  title: string;
  contentHash: string;
  mediaType: string;
}

export async function readDirectTextEvidence(
  input: DirectTextEvidenceInput,
): Promise<EvidenceIR> {
  const buffer = await readFile(input.filePath);
  if (buffer.length === 0) {
    throw new IngestionFailure(
      "empty_file",
      `file is empty: ${input.filePath}`,
    );
  }
  if (buffer.includes(0)) {
    throw new IngestionFailure(
      "binary_file",
      `file contains NUL bytes: ${input.filePath}`,
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new IngestionFailure(
      "binary_file",
      `file is not valid UTF-8: ${input.filePath}`,
    );
  }
  if (text.trim().length === 0) {
    throw new IngestionFailure(
      "empty_file",
      `file has no non-whitespace content: ${input.filePath}`,
    );
  }
  return {
    documentMeta: {
      title: input.title,
      mediaType: input.mediaType,
      contentHash: input.contentHash,
      parserEngine: DIRECT_TEXT_PARSER_ENGINE,
    },
    segments: [
      {
        text,
        anchor: {
          kind: "line",
          filePath: input.title,
          startLine: 1,
          endLine: countLines(text),
        },
      },
    ],
  };
}

function countLines(text: string): number {
  const withoutTrailingNewline = text.endsWith("\n") ? text.slice(0, -1) : text;
  return Math.max(1, withoutTrailingNewline.split("\n").length);
}

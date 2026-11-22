import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { EvidenceIRSchema } from "../src/contracts/evidence-ir.js";

const VALID_HASH = "a".repeat(64);
const SCHEMA_PATH = resolve(
  import.meta.dirname,
  "../../../schemas/evidence-ir.schema.json",
);
const EVIDENCE_IR_JSON_SCHEMA = JSON.parse(
  readFileSync(SCHEMA_PATH, "utf-8"),
) as Record<string, unknown>;
const validateJsonSchema = new Ajv2020({ allErrors: true }).compile(
  EVIDENCE_IR_JSON_SCHEMA,
);

describe("EvidenceIR contract", () => {
  it("validates page, time, and line anchors against Zod and JSON Schema", () => {
    const payload = {
      documentMeta: {
        title: "sample.pdf",
        mediaType: "application/pdf",
        contentHash: VALID_HASH,
        parserEngine: "mineru",
      },
      segments: [
        {
          text: "Section 1 content",
          anchor: { kind: "page", pageNumber: 1, sectionPath: ["Overview"] },
        },
        {
          text: "Speaker utterance",
          anchor: { kind: "time", startMs: 0, endMs: 1200, speaker: "S1" },
        },
        {
          text: "export const version = 1;",
          anchor: {
            kind: "line",
            filePath: "src/index.ts",
            startLine: 1,
            endLine: 1,
          },
        },
      ],
    };

    const parsed = EvidenceIRSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    expect(validateJsonSchema(payload)).toBe(true);
  });

  it("rejects unknown extra fields in both Zod and JSON Schema", () => {
    const payload = {
      documentMeta: {
        title: "sample.pdf",
        mediaType: "application/pdf",
        contentHash: VALID_HASH,
        parserEngine: "mineru",
        unexpectedMeta: true,
      },
      segments: [
        {
          text: "Section 1 content",
          anchor: { kind: "page", pageNumber: 1, sectionPath: [] },
        },
      ],
    };

    expect(EvidenceIRSchema.safeParse(payload).success).toBe(false);
    expect(validateJsonSchema(payload)).toBe(false);
  });

  it("rejects illegal time anchor where startMs >= endMs", () => {
    const payload = {
      documentMeta: {
        title: "meeting.wav",
        mediaType: "audio/wav",
        contentHash: VALID_HASH,
        parserEngine: "asr-api",
      },
      segments: [
        {
          text: "Invalid timestamp",
          anchor: { kind: "time", startMs: 500, endMs: 500 },
        },
      ],
    };

    expect(EvidenceIRSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects illegal line anchor where startLine > endLine", () => {
    const payload = {
      documentMeta: {
        title: "index.ts",
        mediaType: "text/typescript",
        contentHash: VALID_HASH,
        parserEngine: "direct-text",
      },
      segments: [
        {
          text: "Invalid line range",
          anchor: {
            kind: "line",
            filePath: "src/index.ts",
            startLine: 10,
            endLine: 5,
          },
        },
      ],
    };

    expect(EvidenceIRSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects illegal page anchor where pageNumber < 1", () => {
    const payload = {
      documentMeta: {
        title: "sample.pdf",
        mediaType: "application/pdf",
        contentHash: VALID_HASH,
        parserEngine: "mineru",
      },
      segments: [
        {
          text: "Zero page",
          anchor: { kind: "page", pageNumber: 0, sectionPath: [] },
        },
      ],
    };

    expect(EvidenceIRSchema.safeParse(payload).success).toBe(false);
    expect(validateJsonSchema(payload)).toBe(false);
  });
});

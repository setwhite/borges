import { describe, expect, it } from "vitest";
import type { EvidenceIR } from "../src/contracts/evidence-ir.js";
import { type ChunkDraft, chunkEvidence } from "../src/indexing/index.js";

const HASH = "a".repeat(64);

function pageEvidence(text: string, sectionPath: string[] = []): EvidenceIR {
  return {
    documentMeta: {
      title: "guide.pdf",
      mediaType: "application/pdf",
      contentHash: HASH,
      parserEngine: "mineru",
    },
    segments: [
      {
        text,
        anchor: { kind: "page", pageNumber: 1, sectionPath },
      },
    ],
  };
}

function lineEvidence(text: string): EvidenceIR {
  const withoutTrailingNewline = text.endsWith("\n") ? text.slice(0, -1) : text;
  return {
    documentMeta: {
      title: "notes.md",
      mediaType: "text/markdown",
      contentHash: HASH,
      parserEngine: "direct-text",
    },
    segments: [
      {
        text,
        anchor: {
          kind: "line",
          filePath: "notes.md",
          startLine: 1,
          endLine: Math.max(1, withoutTrailingNewline.split("\n").length),
        },
      },
    ],
  };
}

function chunkAt(chunks: ChunkDraft[], index: number): ChunkDraft {
  const chunk = chunks[index];
  if (!chunk) {
    throw new Error(`missing chunk at index ${index}`);
  }
  return chunk;
}

describe("chunkEvidence", () => {
  it("keeps a fenced code block intact when it exceeds maxChars", () => {
    const codeBlock = [
      "```ts",
      ...Array.from(
        { length: 10 },
        (_, index) => `const value${index} = compute(${index});`,
      ),
      "```",
    ].join("\n");
    const intro = "Intro paragraph before the code sample.";
    const outro = "Trailing paragraph after the code sample.";
    const text = `${intro}\n\n${codeBlock}\n\n${outro}`;

    const chunks = chunkEvidence(pageEvidence(text), { maxChars: 80 });

    expect(chunks.map((chunk) => chunk.content)).toEqual([
      intro,
      codeBlock,
      outro,
    ]);
  });

  it("keeps a formula block intact when it exceeds maxChars", () => {
    const formulaBlock = [
      "$$",
      "\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}",
      "E = mc^2",
      "\\int_{0}^{1} x^2 dx = \\frac{1}{3}",
      "a^2 + b^2 = c^2",
      "$$",
    ].join("\n");
    const text = `Before the formula.\n\n${formulaBlock}\n\nAfter the formula.`;

    const chunks = chunkEvidence(pageEvidence(text), { maxChars: 60 });

    expect(chunks.map((chunk) => chunk.content)).toEqual([
      "Before the formula.",
      formulaBlock,
      "After the formula.",
    ]);
  });

  it("keeps an HTML table block intact when it exceeds maxChars", () => {
    const htmlTable = [
      "<table>",
      ...Array.from(
        { length: 8 },
        (_, index) => `<tr><td>row-${index}</td><td>value-${index}</td></tr>`,
      ),
      "</table>",
    ].join("\n");
    const text = `Before the table.\n\n${htmlTable}\n\nAfter the table.`;

    const chunks = chunkEvidence(pageEvidence(text), { maxChars: 70 });

    expect(chunks.map((chunk) => chunk.content)).toEqual([
      "Before the table.",
      htmlTable,
      "After the table.",
    ]);
  });

  it("repeats Markdown table headers on every continuation chunk", () => {
    const header = "| region | revenue |";
    const separator = "| --- | --- |";
    const rows = Array.from(
      { length: 8 },
      (_, index) => `| region-${index} | revenue-value-${index} |`,
    );
    const text = [header, separator, ...rows].join("\n");

    const chunks = chunkEvidence(pageEvidence(text, ["Financials"]), {
      maxChars: 90,
    });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.startsWith(`${header}\n${separator}\n`)).toBe(true);
      expect(chunk.contextHeader).toContain("Section: Financials");
    }
    const collectedRows = chunks.flatMap((chunk) =>
      chunk.content.split("\n").slice(2),
    );
    expect(collectedRows).toEqual(rows);
  });

  it("stores verbatim content separately from the context header", () => {
    const text = "# Setup\n\nAlpha beta gamma.";
    const [chunk] = chunkEvidence(pageEvidence(text, ["Guide"]), {
      maxChars: 1000,
    });

    expect(chunk).toBeDefined();
    expect(chunk?.content).toBe(text);
    expect(chunk?.contextHeader).toContain("Document: guide.pdf");
    expect(chunk?.contextHeader).toContain("Section: Guide > Setup");
    expect(chunk?.contextHeader).not.toContain("Alpha beta gamma.");
    expect(chunk?.searchText).toBe(`${chunk?.contextHeader}\n\n${text}`);
  });

  it("ignores heading-like lines inside protected blocks", () => {
    const text = [
      "# Real Heading",
      "",
      "```python",
      "# this is a python comment",
      "print('hello')",
      "```",
      "",
      "After the code block.",
    ].join("\n");

    const chunks = chunkEvidence(lineEvidence(text), { maxChars: 120 });

    for (const chunk of chunks) {
      expect(chunk.contextHeader).not.toContain("python comment");
    }
    const after = chunks.find(
      (chunk) => chunk.content === "After the code block.",
    );
    expect(after).toBeDefined();
    expect(after?.contextHeader).toContain("Section: Real Heading");
    expect(after?.searchText).not.toContain("python comment");
  });

  it("maps chunk boundaries back to line anchors", () => {
    const lines = Array.from(
      { length: 10 },
      (_, index) => `line ${index + 1} with payload`,
    );
    const text = lines.join("\n");

    const chunks = chunkEvidence(lineEvidence(text), { maxChars: 30 });

    expect(chunks).toHaveLength(10);
    expect(chunks.map((chunk) => chunk.content)).toEqual(lines);
    expect(chunkAt(chunks, 0).anchor).toEqual({
      kind: "line",
      filePath: "notes.md",
      startLine: 1,
      endLine: 1,
    });
    expect(chunkAt(chunks, chunks.length - 1).anchor).toEqual({
      kind: "line",
      filePath: "notes.md",
      startLine: 10,
      endLine: 10,
    });
  });
});

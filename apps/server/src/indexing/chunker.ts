import type {
  Anchor,
  EvidenceIR,
  EvidenceSegment,
} from "../contracts/evidence-ir.js";

export interface ChunkDraft {
  seq: number;
  content: string;
  contextHeader: string;
  searchText: string;
  anchor: Anchor;
}

export interface ChunkerOptions {
  maxChars: number;
}

const DEFAULT_MAX_CHARS = 1200;

const FENCE_START = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const HTML_TABLE_START = /<table[\s>]/i;
const HTML_TABLE_END = /<\/table>/i;
const MARKDOWN_TABLE_SEPARATOR = /^\|?[\s:|-]+\|?$/;

type BlockKind = "text" | "code" | "formula" | "htmlTable" | "markdownTable";

interface Block {
  kind: BlockKind;
  start: number;
  end: number;
}

interface Slice {
  content: string;
  startLine: number;
  endLine: number;
  headingLine: number;
}

interface Range {
  start: number;
  end: number;
}

interface SegmentLayout {
  text: string;
  lines: string[];
  lineStarts: number[];
  headingsByLine: string[][];
}

export function chunkEvidence(
  evidence: EvidenceIR,
  options: Partial<ChunkerOptions> = {},
): ChunkDraft[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new Error(
      `maxChars must be a positive integer, received ${maxChars}`,
    );
  }
  const title = evidence.documentMeta.title;
  const drafts: ChunkDraft[] = [];
  for (const segment of evidence.segments) {
    const layout = layoutSegment(segment.text);
    for (const slice of sliceSegment(layout, maxChars)) {
      const headingTrail = layout.headingsByLine[slice.headingLine] ?? [];
      const contextHeader = buildContextHeader(
        title,
        segment.anchor,
        headingTrail,
      );
      drafts.push({
        seq: drafts.length,
        content: slice.content,
        contextHeader,
        searchText: contextHeader
          ? `${contextHeader}\n\n${slice.content}`
          : slice.content,
        anchor: anchorForSlice(segment.anchor, slice),
      });
    }
  }
  return drafts;
}

function layoutSegment(text: string): SegmentLayout {
  const withoutTrailingNewline = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lines = withoutTrailingNewline.split("\n");
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  return {
    text,
    lines,
    lineStarts,
    headingsByLine: headingTrails(lines, protectedLineMask(lines)),
  };
}

function headingTrails(lines: string[], protectedLines: boolean[]): string[][] {
  const stack: { level: number; text: string }[] = [];
  const trails: string[][] = [];
  for (let line = 0; line < lines.length; line += 1) {
    const match = protectedLines[line] ? null : HEADING.exec(lines[line] ?? "");
    if (match) {
      const level = match[1]?.length ?? 1;
      while (
        stack.length > 0 &&
        (stack[stack.length - 1]?.level ?? 0) >= level
      ) {
        stack.pop();
      }
      stack.push({ level, text: match[2] ?? "" });
    }
    trails.push(stack.map((entry) => entry.text));
  }
  return trails;
}

function protectedLineMask(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let line = 0;
  while (line < lines.length) {
    if ((lines[line] ?? "").trim() === "") {
      line += 1;
      continue;
    }
    const kind = protectedKindAt(lines, line);
    if (!kind) {
      line += 1;
      continue;
    }
    const endLine = protectedEndLine(lines, line, kind);
    for (let current = line; current <= endLine; current += 1) {
      mask[current] = true;
    }
    line = endLine + 1;
  }
  return mask;
}

function sliceSegment(layout: SegmentLayout, maxChars: number): Slice[] {
  const slices: Slice[] = [];
  const blocks = parseBlocks(layout);
  let pending: Range | null = null;

  const flushPending = () => {
    if (pending) {
      emitRange(layout, pending.start, pending.end, slices);
      pending = null;
    }
  };

  for (const block of blocks) {
    if (block.kind === "text") {
      for (const range of splitTextRange(layout, block, maxChars)) {
        if (!pending) {
          pending = { ...range };
          continue;
        }
        if (range.end - pending.start <= maxChars) {
          pending.end = range.end;
        } else {
          flushPending();
          pending = { ...range };
        }
      }
      continue;
    }
    flushPending();
    if (block.kind === "markdownTable") {
      emitTable(layout, block, maxChars, slices);
      continue;
    }
    emitRange(layout, block.start, block.end, slices);
  }
  flushPending();
  return slices;
}

function emitRange(
  layout: SegmentLayout,
  start: number,
  end: number,
  slices: Slice[],
): void {
  const raw = layout.text.slice(start, end);
  const withoutLeadingNewlines = raw.replace(/^[\r\n]+/, "");
  const content = withoutLeadingNewlines.replace(/[\r\n]+$/, "");
  if (content.trim().length === 0) {
    return;
  }
  const contentStart = start + (raw.length - withoutLeadingNewlines.length);
  const startLine = lineIndexAt(layout, contentStart);
  slices.push({
    content,
    startLine,
    endLine: lineIndexAt(layout, contentStart + content.length - 1),
    headingLine: startLine,
  });
}

function emitTable(
  layout: SegmentLayout,
  block: Block,
  maxChars: number,
  slices: Slice[],
): void {
  if (block.end - block.start <= maxChars) {
    emitRange(layout, block.start, block.end, slices);
    return;
  }
  const tableStartLine = lineIndexAt(layout, block.start);
  const tableEndLine = lineIndexAt(
    layout,
    Math.max(block.start, block.end - 1),
  );
  const headerText = `${layout.lines[tableStartLine] ?? ""}\n${layout.lines[tableStartLine + 1] ?? ""}`;
  const rowStartLine = tableStartLine + 2;
  let rows: { line: number; text: string }[] = [];
  let pieceIndex = 0;

  const flushPiece = () => {
    const firstRow = rows[0];
    const lastRow = rows[rows.length - 1];
    if (!firstRow || !lastRow) {
      return;
    }
    slices.push({
      content: `${headerText}\n${rows.map((row) => row.text).join("\n")}`,
      startLine: pieceIndex === 0 ? tableStartLine : firstRow.line,
      endLine: lastRow.line,
      headingLine: tableStartLine,
    });
    pieceIndex += 1;
    rows = [];
  };

  for (let line = rowStartLine; line <= tableEndLine; line += 1) {
    const rowText = layout.lines[line] ?? "";
    if (!rowText.trimStart().startsWith("|")) {
      continue;
    }
    if (rows.length > 0) {
      const candidate = `${headerText}\n${[...rows.map((row) => row.text), rowText].join("\n")}`;
      if (candidate.length > maxChars) {
        flushPiece();
      }
    }
    rows.push({ line, text: rowText });
  }
  flushPiece();
}

function parseBlocks(layout: SegmentLayout): Block[] {
  const blocks: Block[] = [];
  let line = 0;
  while (line < layout.lines.length) {
    if ((layout.lines[line] ?? "").trim() === "") {
      line += 1;
      continue;
    }
    const kind = protectedKindAt(layout.lines, line);
    if (kind) {
      const endLine = protectedEndLine(layout.lines, line, kind);
      blocks.push({
        kind,
        start: layout.lineStarts[line] ?? 0,
        end: lineEndOffset(layout, endLine),
      });
      line = endLine + 1;
      continue;
    }
    const startLine = line;
    while (
      line < layout.lines.length &&
      (layout.lines[line] ?? "").trim() !== "" &&
      protectedKindAt(layout.lines, line) === null
    ) {
      line += 1;
    }
    blocks.push({
      kind: "text",
      start: layout.lineStarts[startLine] ?? 0,
      end:
        line < layout.lines.length
          ? (layout.lineStarts[line] ?? layout.text.length)
          : layout.text.length,
    });
  }
  return blocks;
}

function protectedKindAt(lines: string[], line: number): BlockKind | null {
  const text = lines[line] ?? "";
  if (FENCE_START.test(text)) {
    return "code";
  }
  if (text.trimStart().startsWith("$$")) {
    return "formula";
  }
  if (HTML_TABLE_START.test(text)) {
    return "htmlTable";
  }
  if (isMarkdownTableStart(lines, line)) {
    return "markdownTable";
  }
  return null;
}

function protectedEndLine(
  lines: string[],
  startLine: number,
  kind: BlockKind,
): number {
  const lastLine = lines.length - 1;
  if (kind === "code") {
    const marker = FENCE_START.exec(lines[startLine] ?? "")?.[1] ?? "```";
    const closing = new RegExp(
      `^\\s{0,3}${marker[0] ?? "`"}{${marker.length},}\\s*$`,
    );
    for (let line = startLine + 1; line < lines.length; line += 1) {
      if (closing.test(lines[line] ?? "")) {
        return line;
      }
    }
    return lastLine;
  }
  if (kind === "formula") {
    const opening = (lines[startLine] ?? "").trim();
    if (opening.slice(2).includes("$$")) {
      return startLine;
    }
    for (let line = startLine + 1; line < lines.length; line += 1) {
      if ((lines[line] ?? "").trim().endsWith("$$")) {
        return line;
      }
    }
    return lastLine;
  }
  if (kind === "htmlTable") {
    for (let line = startLine; line < lines.length; line += 1) {
      if (HTML_TABLE_END.test(lines[line] ?? "")) {
        return line;
      }
    }
    return lastLine;
  }
  let end = startLine + 1;
  while (
    end + 1 < lines.length &&
    (lines[end + 1] ?? "").trimStart().startsWith("|")
  ) {
    end += 1;
  }
  return end;
}

function isMarkdownTableStart(lines: string[], line: number): boolean {
  const separator = lines[line + 1];
  if (separator === undefined) {
    return false;
  }
  if (!(lines[line] ?? "").trimStart().startsWith("|")) {
    return false;
  }
  const trimmed = separator.trim();
  return (
    trimmed.includes("|") &&
    trimmed.includes("-") &&
    MARKDOWN_TABLE_SEPARATOR.test(trimmed)
  );
}

function splitTextRange(
  layout: SegmentLayout,
  block: Block,
  maxChars: number,
): Range[] {
  const startLine = lineIndexAt(layout, block.start);
  const endLine = lineIndexAt(layout, Math.max(block.start, block.end - 1));
  const ranges: Range[] = [];
  for (let line = startLine; line <= endLine; line += 1) {
    const lineStart = Math.max(
      layout.lineStarts[line] ?? block.start,
      block.start,
    );
    const lineEnd = Math.min(lineEndOffset(layout, line), block.end);
    if (lineEnd <= lineStart) {
      continue;
    }
    if (lineEnd - lineStart <= maxChars) {
      ranges.push({ start: lineStart, end: lineEnd });
      continue;
    }
    ranges.push(
      ...splitOversizedLine(layout.text, lineStart, lineEnd, maxChars),
    );
  }
  return packRanges(ranges, maxChars);
}

function splitOversizedLine(
  text: string,
  start: number,
  end: number,
  maxChars: number,
): Range[] {
  const ranges: Range[] = [];
  let offset = start;
  while (offset < end) {
    let cut = Math.min(offset + maxChars, end);
    if (cut < end) {
      const window = text.slice(offset, cut);
      const breakAt = lastBreakIndex(window);
      if (breakAt > 0) {
        cut = offset + breakAt;
      }
      if (cut < end && isHighSurrogate(text.charCodeAt(cut - 1))) {
        cut -= 1;
      }
    }
    if (cut <= offset) {
      cut = Math.min(offset + maxChars, end);
    }
    ranges.push({ start: offset, end: cut });
    offset = cut;
  }
  return ranges;
}

function lastBreakIndex(window: string): number {
  const separators = [
    "。",
    "！",
    "？",
    ". ",
    "! ",
    "? ",
    "；",
    "; ",
    "，",
    ", ",
    " ",
  ];
  let best = -1;
  for (const separator of separators) {
    const index = window.lastIndexOf(separator);
    if (index > 0) {
      best = Math.max(best, index + separator.length);
    }
  }
  return best;
}

function packRanges(ranges: Range[], maxChars: number): Range[] {
  const packed: Range[] = [];
  let current: Range | null = null;
  for (const range of ranges) {
    if (!current) {
      current = { ...range };
      continue;
    }
    if (range.end - current.start <= maxChars) {
      current.end = range.end;
    } else {
      packed.push(current);
      current = { ...range };
    }
  }
  if (current) {
    packed.push(current);
  }
  return packed;
}

function anchorForSlice(anchor: Anchor, slice: Slice): Anchor {
  if (anchor.kind !== "line") {
    return anchor;
  }
  return {
    kind: "line",
    filePath: anchor.filePath,
    startLine: Math.min(anchor.startLine + slice.startLine, anchor.endLine),
    endLine: Math.min(anchor.startLine + slice.endLine, anchor.endLine),
  };
}

function buildContextHeader(
  title: string,
  anchor: Anchor,
  headingTrail: string[],
): string {
  const parts = [`Document: ${title}`];
  const section = anchor.kind === "page" ? [...anchor.sectionPath] : [];
  for (const heading of headingTrail) {
    if (section[section.length - 1] !== heading) {
      section.push(heading);
    }
  }
  if (section.length > 0) {
    parts.push(`Section: ${section.join(" > ")}`);
  }
  if (anchor.kind === "line") {
    parts.push(`Path: ${anchor.filePath}`);
  }
  if (anchor.kind === "time" && anchor.speaker) {
    parts.push(`Speaker: ${anchor.speaker}`);
  }
  return parts.join("\n");
}

function lineIndexAt(layout: SegmentLayout, offset: number): number {
  const starts = layout.lineStarts;
  let low = 0;
  let high = Math.max(starts.length - 1, 0);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((starts[mid] ?? 0) <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

function lineEndOffset(layout: SegmentLayout, line: number): number {
  const start = layout.lineStarts[line] ?? layout.text.length;
  return Math.min(
    start + (layout.lines[line] ?? "").length,
    layout.text.length,
  );
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

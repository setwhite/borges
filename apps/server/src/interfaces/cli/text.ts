import type { AskResponse } from "../../agent/index.js";
import type { Anchor } from "../../contracts/evidence-ir.js";
import type { IngestionJobView, SourceView } from "../../ingestion/index.js";
import type { SearchHit } from "../../retrieval/index.js";

export function renderSources(sources: readonly SourceView[]): string {
  if (sources.length === 0) {
    return "No sources.";
  }
  return sources
    .map(
      (source) =>
        `${source.sourceId}  ${source.name}  tenant=${source.tenantId}  acl=[${source.aclTags.join(", ")}]`,
    )
    .join("\n");
}

export function renderJob(job: IngestionJobView): string {
  const lines = [
    `job ${job.jobId}  status=${job.status}  source=${job.sourceId}  document=${job.documentId ?? "-"}`,
  ];
  if (job.errorCode) {
    lines.push(`error ${job.errorCode}: ${job.errorMessage ?? ""}`.trim());
  }
  return lines.join("\n");
}

export function renderHits(hits: readonly SearchHit[]): string {
  if (hits.length === 0) {
    return "No hits.";
  }
  return hits
    .map((hit, index) => {
      const header = `${index + 1}. [${formatAnchor(hit.anchor)}] score=${hit.score.toFixed(3)} chunk=${hit.chunkId}`;
      const body = hit.content
        .split("\n")
        .map((line) => `   ${line}`)
        .join("\n");
      return `${header}\n${body}`;
    })
    .join("\n\n");
}

export function renderAsk(response: AskResponse): string {
  const lines = [response.answer];
  if (response.refused) {
    lines.push("", "Refused: no verifiable citations.");
    return lines.join("\n");
  }
  lines.push("", "Citations:");
  for (const citation of response.citations) {
    lines.push(
      `- ${citation.chunkId}  source=${citation.sourceId}  ${formatAnchor(citation.anchor)}`,
    );
  }
  return lines.join("\n");
}

function formatAnchor(anchor: Anchor): string {
  switch (anchor.kind) {
    case "page":
      return `page ${anchor.pageNumber}${anchor.sectionPath.length > 0 ? ` (${anchor.sectionPath.join(" > ")})` : ""}`;
    case "time":
      return `${formatMilliseconds(anchor.startMs)}-${formatMilliseconds(anchor.endMs)}${anchor.speaker ? ` ${anchor.speaker}` : ""}`;
    case "line":
      return `${anchor.filePath}:${anchor.startLine}-${anchor.endLine}`;
  }
}

function formatMilliseconds(value: number): string {
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.floor((value % 60_000) / 1000);
  const milliseconds = value % 1000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

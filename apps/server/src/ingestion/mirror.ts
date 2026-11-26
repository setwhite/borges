import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { IngestionFailure } from "./failures.js";

interface MirrorLocation {
  mirrorRoot: string;
  sourceId: string;
  relativePath: string;
}

interface MirrorWriteInput extends MirrorLocation {
  content: string;
}

const MAX_PATH_SEGMENT_BYTES = 255;

export function defaultMirrorRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.resolve(
    env.MIRROR_ROOT ?? path.join(process.cwd(), ".data", "mirror"),
  );
}

function resolveMirrorPath(input: MirrorLocation): string {
  const sourceDirectory = path.resolve(input.mirrorRoot, input.sourceId);
  const target = path.resolve(sourceDirectory, input.relativePath);
  const relative = path.relative(sourceDirectory, target);
  if (
    relative.length === 0 ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new IngestionFailure(
      "mirror_path_escape",
      `mirror path escapes source directory: ${input.relativePath}`,
    );
  }
  for (const segment of relative.split(path.sep)) {
    const byteLength = Buffer.byteLength(segment, "utf8");
    if (byteLength > MAX_PATH_SEGMENT_BYTES) {
      throw new IngestionFailure(
        "invalid_title",
        `mirror path segment is ${byteLength} UTF-8 bytes, maximum is ${MAX_PATH_SEGMENT_BYTES}: ${segment.slice(0, 80)}`,
      );
    }
  }
  return target;
}

export function validateMirrorPath(input: MirrorLocation): void {
  resolveMirrorPath(input);
}

export async function writeMirrorFile(input: MirrorWriteInput): Promise<void> {
  const target = resolveMirrorPath(input);
  const directory = path.dirname(target);
  try {
    await mkdir(directory, { recursive: true });
  } catch (error) {
    throw toMirrorWriteFailure(error);
  }
  const temporary = path.join(
    directory,
    `.borges-${randomUUID().slice(0, 8)}.tmp`,
  );
  try {
    await writeFile(temporary, input.content, "utf8");
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw toMirrorWriteFailure(error);
  }
}

export async function deleteMirrorFile(input: MirrorLocation): Promise<void> {
  const target = resolveMirrorPath(input);
  try {
    await unlink(target);
  } catch (error) {
    if (isNotFound(error)) {
      return;
    }
    throw error;
  }
  await removeEmptyParents(
    path.dirname(target),
    path.resolve(input.mirrorRoot, input.sourceId),
  );
}

async function removeEmptyParents(
  directory: string,
  root: string,
): Promise<void> {
  let current = directory;
  while (current !== root) {
    const relative = path.relative(root, current);
    if (
      relative.length === 0 ||
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    ) {
      return;
    }
    try {
      await rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

function toMirrorWriteFailure(error: unknown): IngestionFailure {
  const reason =
    error instanceof Error ? error.message.trim() : String(error).trim();
  return new IngestionFailure(
    "mirror_write_failed",
    `mirror write failed: ${reason || "unknown filesystem error"}`,
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "ENOENT"
  );
}

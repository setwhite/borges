import { z } from "zod";

export const PageAnchorSchema = z
  .object({
    kind: z.literal("page"),
    pageNumber: z.number().int().min(1),
    sectionPath: z.array(z.string()),
  })
  .strict();

export const TimeAnchorSchema = z
  .object({
    kind: z.literal("time"),
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(1),
    speaker: z.string().min(1).optional(),
  })
  .strict()
  .refine((val) => val.startMs < val.endMs, {
    message: "startMs must be strictly less than endMs",
  });

export const LineAnchorSchema = z
  .object({
    kind: z.literal("line"),
    filePath: z.string().min(1),
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
  })
  .strict()
  .refine((val) => val.startLine <= val.endLine, {
    message: "startLine must be less than or equal to endLine",
  });

export const AnchorSchema = z.union([
  PageAnchorSchema,
  TimeAnchorSchema,
  LineAnchorSchema,
]);

export const EvidenceSegmentSchema = z
  .object({
    text: z.string().min(1),
    anchor: AnchorSchema,
    attachments: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const EvidenceIRSchema = z
  .object({
    documentMeta: z
      .object({
        title: z.string().min(1),
        mediaType: z.string().min(1),
        contentHash: z.string().regex(/^[a-f0-9]{64}$/),
        parserEngine: z.string().min(1),
      })
      .strict(),
    segments: z.array(EvidenceSegmentSchema),
  })
  .strict();

export type Anchor = z.infer<typeof AnchorSchema>;
export type EvidenceSegment = z.infer<typeof EvidenceSegmentSchema>;
export type EvidenceIR = z.infer<typeof EvidenceIRSchema>;

/**
 * Output shaping helpers: minimal row schemas, id prefixes, compact
 * timestamps, truncation with size hints, and limit/total accounting.
 */

import { AxiError } from "axi-sdk-js";

export function shortId(id: string | null | undefined): string | null {
  if (typeof id !== "string" || id.length === 0) return null;
  return id.length > 12 ? id.slice(0, 8) : id;
}

/** Daemon timestamps are epoch ms; rows render epoch seconds. */
export function epochSeconds(ms: number | null | undefined): number | null {
  return typeof ms === "number" && Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export function truncate(
  text: string,
  limit: number,
  escape: "chars" | "full",
): { text: string; hint: string | null } {
  if (escape === "full" || text.length <= limit) return { text, hint: null };
  return {
    text: text.slice(0, limit),
    hint: `truncated, ${text.length} chars total — use --full to see complete text`,
  };
}

export interface RowSelection<T> {
  rows: Array<Record<string, unknown>>;
  shown: number;
  total: number;
  truncated: boolean;
}

/**
 * Project records into TOON rows with a minimal default schema, applying
 * `--fields` overrides and a `--limit` cap (`--limit 0` = all).
 */
export function selectRows<T>(
  items: T[],
  defaults: string[],
  options: { fields?: string; limit?: number },
  availableFields: string[],
  rowMapper: (item: T) => Record<string, unknown>,
): RowSelection<T> {
  let fields = defaults;
  if (options.fields) {
    const requested = options.fields.split(",").map((f) => f.trim()).filter(Boolean);
    const unknown = requested.filter((f) => !availableFields.includes(f));
    if (unknown.length > 0) {
      throwFieldsError(unknown, availableFields);
    }
    if (requested.length > 0) fields = requested;
  }
  const limit = options.limit === undefined ? 50 : Math.max(0, Math.floor(options.limit));
  const total = items.length;
  const capped = limit === 0 ? items : items.slice(0, limit);
  const rows = capped.map((item) => {
    const mapped = rowMapper(item);
    const out: Record<string, unknown> = {};
    for (const field of fields) {
      if (field in mapped) out[field] = mapped[field];
    }
    return out;
  });
  return { rows, shown: rows.length, total, truncated: limit !== 0 && total > limit };
}

export function throwFieldsError(unknown: string[], available: string[]): never {
  throw new AxiError(
    `unknown --fields: ${unknown.join(", ")}`,
    "VALIDATION_ERROR",
    [`available fields: ${available.join(", ")}`],
  );
}

export function limitHelpLine(command: string, shown: number, total: number, usedLimit: number): string | null {
  if (usedLimit !== 0 && shown < total) {
    return `Run \`open-design-axi ${command} --limit 0\` for all ${total} items`;
  }
  return null;
}

const TEXT_EXTENSION_KIND: Record<string, string> = {
  html: "html", htm: "html",
  css: "text", md: "text", txt: "text", json: "text", csv: "text", xml: "text", svg: "text",
  js: "code", mjs: "code", cjs: "code", jsx: "code", ts: "code", tsx: "code",
  py: "code", rb: "code", go: "code", rs: "code", sh: "code",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", avif: "image",
  mp4: "video", webm: "video", mov: "video",
  mp3: "audio", wav: "audio", ogg: "audio",
  pdf: "pdf",
};

export function kindForPath(name: string): string {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return TEXT_EXTENSION_KIND[ext] ?? "text";
}

const TEXTUAL_KINDS = new Set(["html", "text", "code"]);

export function isTextualKind(kind: string): boolean {
  return TEXTUAL_KINDS.has(kind);
}

/** unix seconds → compact ISO like 2026-09-13T22:15Z (detail views only). */
export function isoSeconds(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

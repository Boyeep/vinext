export type ByteRange =
  | { kind: "ignore" }
  | { kind: "unsatisfiable" }
  | { kind: "range"; start: number; end: number };

/**
 * Parse a single bytes range. Unsupported range units, malformed values, and
 * multipart ranges are ignored, which RFC 9110 permits servers to do.
 */
export function parseByteRange(value: string | undefined, size: number): ByteRange {
  if (!value || value.slice(0, 6).toLowerCase() !== "bytes=") return { kind: "ignore" };

  const spec = value.slice("bytes=".length).trim();
  if (spec.includes(",")) return { kind: "ignore" };

  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match || (!match[1] && !match[2])) return { kind: "ignore" };

  if (!match[1]) {
    const suffixLength = parseDecimalInteger(match[2]);
    if (suffixLength === null) return { kind: "ignore" };
    if (suffixLength === 0 || size === 0) return { kind: "unsatisfiable" };
    return {
      kind: "range",
      start: Math.max(size - suffixLength, 0),
      end: size - 1,
    };
  }

  const start = parseDecimalInteger(match[1]);
  const requestedEnd = match[2] ? parseDecimalInteger(match[2]) : size - 1;
  if (start === null || requestedEnd === null) return { kind: "ignore" };
  if (start >= size || requestedEnd < start) return { kind: "unsatisfiable" };

  return {
    kind: "range",
    start,
    end: Math.min(requestedEnd, size - 1),
  };
}

/**
 * If-Range requires strong entity-tag comparison. Date validators are matched
 * at HTTP-date (whole-second) precision because filesystem mtimes are finer.
 */
export function ifRangeAllowsRange(
  value: string | undefined,
  etag: string,
  mtimeMs: number,
): boolean {
  if (!value) return true;

  const trimmed = value.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("W/")) {
    return !trimmed.startsWith("W/") && !etag.startsWith("W/") && trimmed === etag;
  }

  const timestamp = Date.parse(trimmed);
  return Number.isFinite(timestamp) && Math.floor(mtimeMs / 1000) * 1000 <= timestamp;
}

function parseDecimalInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

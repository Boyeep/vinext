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
    if (suffixLength === "overflow") {
      if (size === 0) return { kind: "unsatisfiable" };
      return { kind: "range", start: 0, end: size - 1 };
    }
    if (suffixLength === 0 || size === 0) return { kind: "unsatisfiable" };
    return {
      kind: "range",
      start: Math.max(size - suffixLength, 0),
      end: size - 1,
    };
  }

  const start = parseDecimalInteger(match[1]);
  const requestedEnd = match[2] ? parseDecimalInteger(match[2]) : size - 1;
  // The wire grammar has no JavaScript-safe-integer limit. A start beyond
  // that limit is necessarily beyond any file size Node can address, while an
  // overflowing end still denotes the remainder of the representation.
  if (start === "overflow") return { kind: "unsatisfiable" };
  if (requestedEnd === "overflow") {
    if (start >= size) return { kind: "unsatisfiable" };
    return { kind: "range", start, end: size - 1 };
  }
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

  const timestamp = parseHttpDate(trimmed);
  return Number.isFinite(timestamp) && Math.floor(mtimeMs / 1000) * 1000 === timestamp;
}

const IMF_FIXDATE_RE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const RFC850_DATE_RE =
  /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const ASCTIME_DATE_RE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: (\d)|(\d{2})) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Sunday: 0,
  Mon: 1,
  Monday: 1,
  Tue: 2,
  Tuesday: 2,
  Wed: 3,
  Wednesday: 3,
  Thu: 4,
  Thursday: 4,
  Fri: 5,
  Friday: 5,
  Sat: 6,
  Saturday: 6,
};
const MONTH_INDEX: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

/** Parse only the three HTTP-date wire formats accepted by RFC 9110. */
function parseHttpDate(value: string): number {
  const imf = IMF_FIXDATE_RE.exec(value);
  if (imf) {
    return timestampFromHttpDateParts(imf[1], imf[2], imf[3], imf[4], imf[5], imf[6], imf[7]);
  }

  const rfc850 = RFC850_DATE_RE.exec(value);
  if (rfc850) {
    const currentYear = new Date().getUTCFullYear();
    let year = currentYear - (currentYear % 100) + Number(rfc850[4]);
    if (year > currentYear + 50) year -= 100;
    return timestampFromHttpDateParts(
      rfc850[1],
      rfc850[2],
      rfc850[3],
      String(year),
      rfc850[5],
      rfc850[6],
      rfc850[7],
    );
  }

  const asctime = ASCTIME_DATE_RE.exec(value);
  if (asctime) {
    return timestampFromHttpDateParts(
      asctime[1],
      asctime[3] || asctime[4],
      asctime[2],
      asctime[8],
      asctime[5],
      asctime[6],
      asctime[7],
    );
  }

  return Number.NaN;
}

function timestampFromHttpDateParts(
  weekday: string,
  dayValue: string,
  monthValue: string,
  yearValue: string,
  hourValue: string,
  minuteValue: string,
  secondValue: string,
): number {
  const day = Number(dayValue);
  const month = MONTH_INDEX[monthValue];
  const year = Number(yearValue);
  const hour = Number(hourValue);
  const minute = Number(minuteValue);
  const second = Number(secondValue);

  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second ||
    date.getUTCDay() !== WEEKDAY_INDEX[weekday]
  ) {
    return Number.NaN;
  }
  return date.getTime();
}

function parseDecimalInteger(value: string): number | "overflow" {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : "overflow";
}

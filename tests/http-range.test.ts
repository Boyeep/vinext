import { describe, expect, it } from "vitest";
import { ifRangeAllowsRange, parseByteRange } from "../packages/vinext/src/server/http-range.js";

describe("parseByteRange", () => {
  it("parses bounded and open-ended ranges", () => {
    expect(parseByteRange("bytes=2-5", 10)).toEqual({ kind: "range", start: 2, end: 5 });
    expect(parseByteRange("bytes=7-", 10)).toEqual({ kind: "range", start: 7, end: 9 });
  });

  it("parses suffix ranges and clamps them to the representation", () => {
    expect(parseByteRange("bytes=-3", 10)).toEqual({ kind: "range", start: 7, end: 9 });
    expect(parseByteRange("bytes=-20", 10)).toEqual({ kind: "range", start: 0, end: 9 });
  });

  it("parses case-insensitive range units and clamps an oversized end", () => {
    expect(parseByteRange("BYTES=8-99", 10)).toEqual({ kind: "range", start: 8, end: 9 });
  });

  it("marks valid but impossible ranges unsatisfiable", () => {
    expect(parseByteRange("bytes=10-", 10)).toEqual({ kind: "unsatisfiable" });
    expect(parseByteRange("bytes=7-3", 10)).toEqual({ kind: "unsatisfiable" });
    expect(parseByteRange("bytes=-0", 10)).toEqual({ kind: "unsatisfiable" });
    expect(parseByteRange("bytes=0-", 0)).toEqual({ kind: "unsatisfiable" });
  });

  it("ignores malformed, unsupported, and multipart ranges", () => {
    expect(parseByteRange(undefined, 10)).toEqual({ kind: "ignore" });
    expect(parseByteRange("items=0-2", 10)).toEqual({ kind: "ignore" });
    expect(parseByteRange("bytes=abc", 10)).toEqual({ kind: "ignore" });
    expect(parseByteRange("bytes=0-1,4-5", 10)).toEqual({ kind: "ignore" });
  });

  it("preserves valid range semantics above Number.MAX_SAFE_INTEGER", () => {
    expect(parseByteRange("bytes=9007199254740992-", 10)).toEqual({ kind: "unsatisfiable" });
    expect(parseByteRange("bytes=2-9007199254740992", 10)).toEqual({
      kind: "range",
      start: 2,
      end: 9,
    });
    expect(parseByteRange("bytes=-9007199254740992", 10)).toEqual({
      kind: "range",
      start: 0,
      end: 9,
    });
    expect(parseByteRange("bytes=-9007199254740992", 0)).toEqual({ kind: "unsatisfiable" });
  });
});

describe("ifRangeAllowsRange", () => {
  const mtimeMs = Date.parse("2026-01-01T00:00:00.500Z");

  it("accepts an absent validator and an identical strong ETag", () => {
    expect(ifRangeAllowsRange(undefined, '"asset"', mtimeMs)).toBe(true);
    expect(ifRangeAllowsRange('"asset"', '"asset"', mtimeMs)).toBe(true);
  });

  it("rejects weak or different entity tags", () => {
    expect(ifRangeAllowsRange('W/"asset"', '"asset"', mtimeMs)).toBe(false);
    expect(ifRangeAllowsRange('"asset"', 'W/"asset"', mtimeMs)).toBe(false);
    expect(ifRangeAllowsRange('"other"', '"asset"', mtimeMs)).toBe(false);
  });

  it("accepts only an exact whole-second Last-Modified date", () => {
    expect(ifRangeAllowsRange("Thu, 01 Jan 2026 00:00:00 GMT", '"asset"', mtimeMs)).toBe(true);
    expect(ifRangeAllowsRange("Thu, 01 Jan 2026 00:00:01 GMT", '"asset"', mtimeMs)).toBe(false);
  });

  it("rejects stale or invalid dates", () => {
    expect(ifRangeAllowsRange("Wed, 31 Dec 2025 23:59:59 GMT", '"asset"', mtimeMs)).toBe(false);
    expect(ifRangeAllowsRange("not-a-date", '"asset"', mtimeMs)).toBe(false);
    expect(ifRangeAllowsRange("12/31/2099", '"asset"', mtimeMs)).toBe(false);
    expect(ifRangeAllowsRange("2099-12-31", '"asset"', mtimeMs)).toBe(false);
    expect(ifRangeAllowsRange("Sun, 31 Feb 2099 00:00:00 GMT", '"asset"', mtimeMs)).toBe(false);
    expect(ifRangeAllowsRange("Fri, 01 Jan 2026 00:00:00 GMT", '"asset"', mtimeMs)).toBe(false);
  });

  it("accepts obsolete HTTP-date formats required for recipients", () => {
    expect(ifRangeAllowsRange("Thursday, 01-Jan-26 00:00:00 GMT", '"asset"', mtimeMs)).toBe(true);
    expect(ifRangeAllowsRange("Thu Jan  1 00:00:00 2026", '"asset"', mtimeMs)).toBe(true);
  });
});

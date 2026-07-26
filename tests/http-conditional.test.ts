import { describe, expect, it } from "vitest";
import { matchesIfNoneMatch } from "../packages/vinext/src/server/http-conditional.js";

describe("matchesIfNoneMatch", () => {
  it("matches an identical entity tag", () => {
    expect(matchesIfNoneMatch('"asset"', '"asset"')).toBe(true);
  });

  it("uses weak comparison in either direction", () => {
    expect(matchesIfNoneMatch('"asset"', 'W/"asset"')).toBe(true);
    expect(matchesIfNoneMatch('W/"asset"', '"asset"')).toBe(true);
  });

  it("matches a validator within a comma-separated field value", () => {
    expect(matchesIfNoneMatch('"other", W/"asset", "last"', '"asset"')).toBe(true);
  });

  it("matches a wildcard with optional whitespace", () => {
    expect(matchesIfNoneMatch("  *  ", 'W/"asset"')).toBe(true);
  });

  it("does not match different opaque tags or case", () => {
    expect(matchesIfNoneMatch('"other"', '"asset"')).toBe(false);
    expect(matchesIfNoneMatch('"ASSET"', '"asset"')).toBe(false);
  });

  it("does not treat a lowercase weak prefix as W/", () => {
    expect(matchesIfNoneMatch('w/"asset"', '"asset"')).toBe(false);
  });

  it("rejects an absent or empty field value", () => {
    expect(matchesIfNoneMatch(undefined, '"asset"')).toBe(false);
    expect(matchesIfNoneMatch("", '"asset"')).toBe(false);
  });
});

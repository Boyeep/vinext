import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createDevPublicFileEtags,
  resolveDevPublicIfNoneMatch,
  updateDevPublicFileEtag,
} from "../packages/vinext/src/server/dev-public-etag.js";

const ETAG = 'W/"90-1234"';
const publicEtags = new Map([["/asset.js", ETAG]]);

describe("resolveDevPublicIfNoneMatch", () => {
  it("normalizes strong and weak validators to sirv's weak ETag", () => {
    expect(resolveDevPublicIfNoneMatch("GET", "/asset.js", '"90-1234"', publicEtags)).toBe(ETAG);
    expect(resolveDevPublicIfNoneMatch("GET", "/asset.js", ETAG, publicEtags)).toBe(ETAG);
  });

  it("handles lists and wildcard validators", () => {
    expect(
      resolveDevPublicIfNoneMatch("GET", "/asset.js?cache=1", '"other", "90-1234"', publicEtags),
    ).toBe(ETAG);
    expect(resolveDevPublicIfNoneMatch("GET", "/asset.js", "*", publicEtags)).toBe(ETAG);
  });

  it("leaves malformed and non-matching validators untouched", () => {
    expect(
      resolveDevPublicIfNoneMatch("GET", "/asset.js", '*, "90-1234"', publicEtags),
    ).toBeUndefined();
    expect(resolveDevPublicIfNoneMatch("GET", "/asset.js", '"other"', publicEtags)).toBeUndefined();
  });

  it("supports HEAD and a configured base path", () => {
    expect(
      resolveDevPublicIfNoneMatch("HEAD", "/base/asset.js", '"90-1234"', publicEtags, "/base"),
    ).toBe(ETAG);
    expect(
      resolveDevPublicIfNoneMatch(
        "GET",
        "/base/a/%2e%2e//asset.js",
        '"90-1234"',
        publicEtags,
        "/base",
      ),
    ).toBe(ETAG);
  });

  it("does not affect methods, missing files, or paths outside basePath", () => {
    expect(
      resolveDevPublicIfNoneMatch("POST", "/asset.js", '"90-1234"', publicEtags),
    ).toBeUndefined();
    expect(
      resolveDevPublicIfNoneMatch("GET", "/missing.js", '"90-1234"', publicEtags),
    ).toBeUndefined();
    expect(
      resolveDevPublicIfNoneMatch("GET", "/asset.js", '"90-1234"', publicEtags, "/base"),
    ).toBeUndefined();
  });

  it("tracks the same size/mtime identity that sirv uses", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-public-etag-"));
    const publicDir = path.join(root, "public");
    const filePath = path.join(publicDir, "asset.js");
    try {
      fs.mkdirSync(publicDir);
      fs.writeFileSync(filePath, "initial");

      const etags = createDevPublicFileEtags(root);
      const initial = etags.get("/asset.js");
      expect(initial).toMatch(/^W\/"7-\d+"$/);

      fs.writeFileSync(filePath, "updated content");
      updateDevPublicFileEtag(etags, root, filePath);
      expect(etags.get("/asset.js")).toMatch(/^W\/"15-\d+"$/);
      expect(etags.get("/asset.js")).not.toBe(initial);

      updateDevPublicFileEtag(etags, root, filePath, true);
      expect(etags.has("/asset.js")).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

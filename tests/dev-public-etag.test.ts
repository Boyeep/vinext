import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toSlash } from "pathslash";
import {
  createDevPublicFileEtags,
  type DevPublicFileEtagIndex,
  resolveDevPublicIfNoneMatch,
  updateDevPublicFileEtag,
} from "../packages/vinext/src/server/dev-public-etag.js";

const ETAG = 'W/"90-1234"';
const publicEtags: DevPublicFileEtagIndex = {
  publicDir: "/public",
  etagsByRealPath: new Map([["/public/asset.js", ETAG]]),
  symlinkTargets: new Map(),
};

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

      const index = createDevPublicFileEtags(root);
      const realPath = toSlash(fs.realpathSync(filePath));
      const initial = index.etagsByRealPath.get(realPath);
      expect(initial).toMatch(/^W\/"7-\d+"$/);

      fs.writeFileSync(filePath, "updated content");
      expect(updateDevPublicFileEtag(index, filePath)).toBe(true);
      expect(index.etagsByRealPath.get(realPath)).toMatch(/^W\/"15-\d+"$/);
      expect(index.etagsByRealPath.get(realPath)).not.toBe(initial);

      fs.rmSync(filePath);
      expect(updateDevPublicFileEtag(index, filePath)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "preserves directory symlink aliases without following cycles",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-public-etag-alias-"));
      const publicDir = path.join(root, "public");
      try {
        fs.mkdirSync(path.join(publicDir, "a"), { recursive: true });
        fs.writeFileSync(path.join(publicDir, "a", "asset.js"), "content");
        fs.symlinkSync("a", path.join(publicDir, "b"), "dir");
        fs.symlinkSync("..", path.join(publicDir, "a", "cycle"), "dir");

        const index = createDevPublicFileEtags(root);
        const etag = index.etagsByRealPath.get(
          toSlash(fs.realpathSync(path.join(publicDir, "a/asset.js"))),
        );
        expect(etag).toMatch(/^W\//);
        expect(resolveDevPublicIfNoneMatch("GET", "/a/asset.js", etag, index)).toBe(etag);
        expect(resolveDevPublicIfNoneMatch("GET", "/b/asset.js", etag, index)).toBe(etag);
        expect(resolveDevPublicIfNoneMatch("GET", "/a/cycle/a/asset.js", etag, index)).toBe(etag);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "updates files reported through a directory symlink's real path",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-public-etag-real-watch-"));
      const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-public-etag-target-"));
      const publicDir = path.join(root, "public");
      const externalFile = path.join(externalDir, "asset.js");
      try {
        fs.mkdirSync(publicDir);
        fs.writeFileSync(externalFile, "initial");
        fs.symlinkSync(externalDir, path.join(publicDir, "alias"), "dir");

        const index = createDevPublicFileEtags(root);
        const initial = resolveDevPublicIfNoneMatch(
          "GET",
          "/alias/asset.js",
          index.etagsByRealPath.get(toSlash(fs.realpathSync(externalFile))),
          index,
        );
        expect(initial).toMatch(/^W\//);

        fs.writeFileSync(externalFile, "updated content");
        expect(updateDevPublicFileEtag(index, externalFile)).toBe(true);
        const updated = index.etagsByRealPath.get(toSlash(fs.realpathSync(externalFile)));
        expect(updated).toMatch(/^W\//);
        expect(updated).not.toBe(initial);
        expect(resolveDevPublicIfNoneMatch("GET", "/alias/asset.js", updated, index)).toBe(updated);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(externalDir, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "win32")("normalizes encoded Windows separators like Vite", () => {
    const nestedEtags: DevPublicFileEtagIndex = {
      publicDir: "/public",
      etagsByRealPath: new Map([["/public/foo/bar.js", ETAG]]),
      symlinkTargets: new Map(),
    };
    expect(resolveDevPublicIfNoneMatch("GET", "/foo%5Cbar.js", '"90-1234"', nestedEtags)).toBe(
      ETAG,
    );
  });
});

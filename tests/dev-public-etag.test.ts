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
  foldedRealPaths: new Map(),
  symlinkTargets: new Map(),
  hasSymlink: false,
  caseInsensitive: false,
  normalizationInsensitive: false,
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

      const index = createDevPublicFileEtags(publicDir);
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

        const index = createDevPublicFileEtags(publicDir);
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

        const index = createDevPublicFileEtags(publicDir);
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

  it.runIf(process.platform !== "win32")(
    "folds served names only when the filesystem is case-insensitive",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-public-etag-case-"));
      const publicDir = path.join(root, "public");
      try {
        fs.mkdirSync(publicDir);
        fs.writeFileSync(path.join(publicDir, "MixedCase.js"), "content");

        const exactSetIndex = createDevPublicFileEtags(publicDir, true);
        exactSetIndex.symlinkTargets.clear();
        expect(
          resolveDevPublicIfNoneMatch("GET", "/mixedcase.js", "*", exactSetIndex),
        ).toBeUndefined();

        fs.symlinkSync("MixedCase.js", path.join(publicDir, "alias.js"));

        const caseInsensitiveIndex = createDevPublicFileEtags(publicDir, true);
        const etag = resolveDevPublicIfNoneMatch("GET", "/mixedcase.js", "*", caseInsensitiveIndex);
        expect(etag).toMatch(/^W\//);
        expect(resolveDevPublicIfNoneMatch("GET", "/ALIAS.JS", "*", caseInsensitiveIndex)).toBe(
          etag,
        );

        const caseSensitiveIndex = createDevPublicFileEtags(publicDir, false);
        expect(
          resolveDevPublicIfNoneMatch("GET", "/mixedcase.js", "*", caseSensitiveIndex),
        ).toBeUndefined();
        expect(
          resolveDevPublicIfNoneMatch("GET", "/MixedCase.js", "*", caseSensitiveIndex),
        ).toMatch(/^W\//);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("fails ambiguous folded names closed while preserving exact spellings", () => {
    const index: DevPublicFileEtagIndex = {
      publicDir: "/public",
      etagsByRealPath: new Map([
        ["/public/A.js", 'W/"5-1"'],
        ["/public/a.js", 'W/"5-2"'],
      ]),
      foldedRealPaths: new Map([["/public/a.js", null]]),
      symlinkTargets: new Map([["/public/alias", "/public/A.js"]]),
      hasSymlink: true,
      caseInsensitive: true,
      normalizationInsensitive: false,
    };
    expect(resolveDevPublicIfNoneMatch("GET", "/A.js", "*", index)).toBe('W/"5-1"');
    expect(resolveDevPublicIfNoneMatch("GET", "/a.js", "*", index)).toBe('W/"5-2"');
    expect(resolveDevPublicIfNoneMatch("GET", "/a.JS", "*", index)).toBeUndefined();
  });

  it.runIf(process.platform !== "win32")(
    "uses dangling symlinks to mirror Vite's stat-based public lookup",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-public-etag-dangling-"));
      const publicDir = path.join(root, "public");
      try {
        fs.mkdirSync(publicDir);
        fs.symlinkSync("missing", path.join(publicDir, "0-broken"));
        fs.writeFileSync(path.join(publicDir, "MixedCase.js"), "content");

        const index = createDevPublicFileEtags(publicDir, true);
        expect(index.hasSymlink).toBe(true);
        expect([...index.symlinkTargets.keys()].some((key) => key.endsWith("/0-broken"))).toBe(
          false,
        );
        expect(resolveDevPublicIfNoneMatch("GET", "/mixedcase.js", "*", index)).toMatch(/^W\//);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not treat a symlinked public root as a child symlink",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-public-etag-root-link-"));
      const actualPublicDir = path.join(root, "actual-public");
      const publicDir = path.join(root, "public");
      try {
        fs.mkdirSync(actualPublicDir);
        fs.writeFileSync(path.join(actualPublicDir, "MixedCase.js"), "content");
        fs.symlinkSync(actualPublicDir, publicDir, "dir");

        const index = createDevPublicFileEtags(publicDir, true);
        expect(index.symlinkTargets.get(toSlash(publicDir))).toBe(
          toSlash(fs.realpathSync.native(actualPublicDir)),
        );
        expect(index.hasSymlink).toBe(false);
        expect(resolveDevPublicIfNoneMatch("GET", "/mixedcase.js", "*", index)).toBeUndefined();
        expect(resolveDevPublicIfNoneMatch("GET", "/MixedCase.js", "*", index)).toMatch(/^W\//);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "folds Unicode case and filesystem normalization aliases",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-public-etag-unicode-"));
      const publicDir = path.join(root, "public");
      try {
        fs.mkdirSync(publicDir);
        fs.writeFileSync(path.join(publicDir, "Éclair.js"), "content");
        fs.symlinkSync("Éclair.js", path.join(publicDir, "alias.js"));

        const index = createDevPublicFileEtags(publicDir, true, true);
        expect(resolveDevPublicIfNoneMatch("GET", "/%C3%A9clair.js", "*", index)).toMatch(/^W\//);
        expect(resolveDevPublicIfNoneMatch("GET", "/e%CC%81clair.js", "*", index)).toMatch(/^W\//);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "win32")("normalizes encoded Windows separators like Vite", () => {
    const nestedEtags: DevPublicFileEtagIndex = {
      publicDir: "/public",
      etagsByRealPath: new Map([["/public/foo/bar.js", ETAG]]),
      foldedRealPaths: new Map(),
      symlinkTargets: new Map(),
      hasSymlink: false,
      caseInsensitive: false,
      normalizationInsensitive: false,
    };
    expect(resolveDevPublicIfNoneMatch("GET", "/foo%5Cbar.js", '"90-1234"', nestedEtags)).toBe(
      ETAG,
    );
  });
});

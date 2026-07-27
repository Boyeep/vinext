import fs from "node:fs";
import path, { toSlash } from "pathslash";
import { hasBasePath, stripBasePath } from "../utils/base-path.js";
import { matchesIfNoneMatch } from "./http-conditional.js";
import { normalizePath } from "./normalize-path.js";

export type DevPublicFileEtagIndex = {
  publicDir: string;
  etagsByRealPath: Map<string, string>;
  foldedRealPaths: Map<string, string | null>;
  symlinkTargets: Map<string, string>;
  hasSymlink: boolean;
  caseInsensitive: boolean;
  normalizationInsensitive: boolean;
};

export function createDevPublicFileEtags(
  externalPublicDir: string,
  caseInsensitive = detectCaseInsensitiveDirectory(externalPublicDir),
  normalizationInsensitive = detectNormalizationInsensitiveDirectory(externalPublicDir),
): DevPublicFileEtagIndex {
  const publicDir = toSlash(externalPublicDir);
  const index: DevPublicFileEtagIndex = {
    publicDir,
    etagsByRealPath: new Map(),
    foldedRealPaths: new Map(),
    symlinkTargets: new Map(),
    hasSymlink: false,
    caseInsensitive,
    normalizationInsensitive,
  };

  const walk = (dir: string, realAncestors: ReadonlySet<string>): void => {
    let realDir: string;
    try {
      realDir = toSlash(fs.realpathSync.native(dir));
    } catch {
      return;
    }
    if (realAncestors.has(realDir)) return;
    const nextAncestors = new Set(realAncestors).add(realDir);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        index.hasSymlink = true;
        let realTarget: string;
        let stats: fs.Stats;
        try {
          realTarget = toSlash(fs.realpathSync.native(fullPath));
          stats = fs.statSync(fullPath);
        } catch {
          continue;
        }
        index.symlinkTargets.set(fullPath, realTarget);
        if (stats.isDirectory()) {
          walk(fullPath, nextAncestors);
        } else if (stats.isFile()) {
          indexFileEtag(index, realTarget, etagForStats(stats));
        }
        continue;
      }
      if (entry.isDirectory()) {
        walk(fullPath, nextAncestors);
        continue;
      }
      if (!entry.isFile()) continue;

      try {
        const realPath = toSlash(fs.realpathSync.native(fullPath));
        indexFileEtag(index, realPath, etagForStats(fs.statSync(fullPath)));
      } catch {
        // Ignore entries removed during the startup scan.
      }
    }
  };

  if (fs.existsSync(publicDir)) {
    const realPublicDir = toSlash(fs.realpathSync.native(publicDir));
    if (realPublicDir !== publicDir) index.symlinkTargets.set(publicDir, realPublicDir);
    walk(publicDir, new Set());
  }
  return index;
}

/**
 * Update a regular public file without rescanning the directory tree.
 * Returns false when a structural change (directory, symlink, or removal)
 * requires the caller to rebuild the index off the request path.
 */
export function updateDevPublicFileEtag(
  index: DevPublicFileEtagIndex,
  externalFilePath: string,
): boolean {
  let filePath = toSlash(externalFilePath);
  if (!isWithinPublicDir(index.publicDir, filePath)) {
    try {
      filePath = toSlash(fs.realpathSync.native(filePath));
    } catch {
      // A removal behind a symlink requires a structural rebuild only when
      // the watcher reports it through the public alias, handled above.
    }
    if (
      ![...index.symlinkTargets.values()].some(
        (target) => filePath === target || filePath.startsWith(target + "/"),
      )
    ) {
      return true;
    }
  }

  try {
    const lstat = fs.lstatSync(filePath);
    if (lstat.isSymbolicLink() || !lstat.isFile()) return false;
    const realPath = toSlash(fs.realpathSync.native(filePath));
    indexFileEtag(index, realPath, etagForStats(fs.statSync(filePath)));
    return true;
  } catch {
    return false;
  }
}

export function resolveDevPublicIfNoneMatch(
  method: string | undefined,
  requestUrl: string | undefined,
  ifNoneMatch: string | string[] | undefined,
  index: DevPublicFileEtagIndex,
  basePath = "",
): string | undefined {
  if ((method !== "GET" && method !== "HEAD") || typeof ifNoneMatch !== "string") {
    return undefined;
  }

  const queryIndex = requestUrl?.indexOf("?") ?? -1;
  let pathname = (requestUrl ?? "/").slice(0, queryIndex === -1 ? undefined : queryIndex);
  if (basePath) {
    if (!hasBasePath(pathname, basePath)) return undefined;
    pathname = stripBasePath(pathname, basePath);
  }
  try {
    // Vite converts native separators on Windows before applying POSIX path
    // normalization. `toSlash` is platform-gated, so a literal backslash
    // remains a valid filename character on POSIX.
    pathname = normalizePath(toSlash(decodeURI(pathname)));
  } catch {
    return undefined;
  }

  let filePath = path.join(index.publicDir, pathname);
  if (!isWithinPublicDir(index.publicDir, filePath)) return undefined;
  // Vite normally guards public requests with an exact-spelling file set. It
  // disables that optimization when the public tree contains a symlink and
  // lets sirv consult the filesystem, which may then accept case aliases.
  const supportsFoldedLookup = index.caseInsensitive && index.hasSymlink;
  filePath = resolveSymlinkTargets(
    filePath,
    index.symlinkTargets,
    supportsFoldedLookup,
    index.normalizationInsensitive,
  );

  let etag = index.etagsByRealPath.get(filePath);
  if (!etag && supportsFoldedLookup) {
    const canonicalPath = index.foldedRealPaths.get(
      foldPath(filePath, index.normalizationInsensitive),
    );
    if (canonicalPath) etag = index.etagsByRealPath.get(canonicalPath);
  }
  return etag && matchesIfNoneMatch(ifNoneMatch, etag) ? etag : undefined;
}

function resolveSymlinkTargets(
  filePath: string,
  targets: ReadonlyMap<string, string>,
  caseInsensitive: boolean,
  normalizationInsensitive: boolean,
): string {
  const seen = new Set<string>();
  while (!seen.has(filePath)) {
    seen.add(filePath);
    let matchedSource: string | undefined;
    const fileSegments = filePath.split("/");
    for (const source of targets.keys()) {
      const sourceSegments = source.split("/");
      if (sourceSegments.length > fileSegments.length) continue;
      const matches = sourceSegments.every((segment, index) => {
        const fileSegment = fileSegments[index]!;
        return caseInsensitive
          ? foldPath(fileSegment, normalizationInsensitive) ===
              foldPath(segment, normalizationInsensitive)
          : fileSegment === segment;
      });
      if (matches && (!matchedSource || sourceSegments.length > matchedSource.split("/").length)) {
        matchedSource = source;
      }
    }
    if (!matchedSource) break;
    const suffix = fileSegments.slice(matchedSource.split("/").length).join("/");
    filePath = path.join(targets.get(matchedSource)!, suffix);
  }
  return filePath;
}

function isWithinPublicDir(publicDir: string, filePath: string): boolean {
  const relativePath = path.relative(publicDir, filePath);
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith("../") &&
    !path.isAbsolute(relativePath)
  );
}

function etagForStats(stats: fs.Stats): string {
  // Vite's public-file middleware delegates to sirv, which uses this
  // size/mtime weak validator in development.
  return `W/"${stats.size}-${stats.mtime.getTime()}"`;
}

function indexFileEtag(index: DevPublicFileEtagIndex, realPath: string, etag: string): void {
  index.etagsByRealPath.set(realPath, etag);
  if (!index.caseInsensitive) return;

  const foldedPath = foldPath(realPath, index.normalizationInsensitive);
  const existing = index.foldedRealPaths.get(foldedPath);
  if (existing === undefined || existing === realPath) {
    index.foldedRealPaths.set(foldedPath, realPath);
  } else {
    // A synthetic or unusual filesystem can expose names which our ASCII fold
    // aliases even though the filesystem does not. Exact spellings remain
    // usable; ambiguous folded spellings fail closed.
    index.foldedRealPaths.set(foldedPath, null);
  }
}

function detectCaseInsensitiveDirectory(externalDir: string): boolean {
  const dir = toSlash(externalDir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    const toggledName = toggleAsciiCase(entry.name);
    if (!toggledName) continue;
    try {
      const actual = toSlash(fs.realpathSync.native(path.join(dir, entry.name)));
      const toggled = toSlash(fs.realpathSync.native(path.join(dir, toggledName)));
      return actual === toggled;
    } catch {
      continue;
    }
  }

  const basename = path.basename(dir);
  const toggledBasename = toggleAsciiCase(basename);
  if (!toggledBasename) return false;
  try {
    return (
      toSlash(fs.realpathSync.native(dir)) ===
      toSlash(fs.realpathSync.native(path.join(path.dirname(dir), toggledBasename)))
    );
  } catch {
    return false;
  }
}

function detectNormalizationInsensitiveDirectory(externalDir: string): boolean {
  const dir = toSlash(externalDir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    const alternateName = alternateNormalization(entry.name);
    if (!alternateName) continue;
    try {
      const actual = toSlash(fs.realpathSync.native(path.join(dir, entry.name)));
      const alternate = toSlash(fs.realpathSync.native(path.join(dir, alternateName)));
      return actual === alternate;
    } catch {
      continue;
    }
  }
  return false;
}

function toggleAsciiCase(value: string): string | undefined {
  const index = value.search(/[A-Za-z]/);
  if (index === -1) return undefined;
  const char = value[index]!;
  const toggled = char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase();
  return value.slice(0, index) + toggled + value.slice(index + 1);
}

function alternateNormalization(value: string): string | undefined {
  const decomposed = value.normalize("NFD");
  if (decomposed !== value) return decomposed;
  const composed = value.normalize("NFC");
  return composed !== value ? composed : undefined;
}

function foldPath(value: string, normalizationInsensitive: boolean): string {
  return (normalizationInsensitive ? value.normalize("NFD") : value).toLowerCase();
}

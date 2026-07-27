import fs from "node:fs";
import path, { toSlash } from "pathslash";
import { hasBasePath, stripBasePath } from "../utils/base-path.js";
import { matchesIfNoneMatch } from "./http-conditional.js";
import { normalizePath } from "./normalize-path.js";

export type DevPublicFileEtagIndex = {
  publicDir: string;
  etagsByRealPath: Map<string, string>;
  requestPathRealPaths: Map<string, string | null>;
  symlinkTargets: Map<string, string>;
  hasSymlink: boolean;
  viteUsesStatLookup: boolean;
  caseInsensitive: boolean;
  normalizationInsensitive: boolean;
};

export function createDevPublicFileEtags(
  externalPublicDir: string,
  caseInsensitive = detectCaseInsensitiveDirectory(externalPublicDir),
  normalizationInsensitive = detectNormalizationInsensitiveDirectory(externalPublicDir),
  viteUsesStatLookup?: boolean,
): DevPublicFileEtagIndex {
  const publicDir = toSlash(externalPublicDir);
  const index: DevPublicFileEtagIndex = {
    publicDir,
    etagsByRealPath: new Map(),
    requestPathRealPaths: new Map(),
    symlinkTargets: new Map(),
    hasSymlink: false,
    viteUsesStatLookup: false,
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
        indexSymlinkTarget(index, fullPath, realTarget);
        if (stats.isDirectory()) {
          walk(fullPath, nextAncestors);
        } else if (stats.isFile()) {
          indexFileEtag(index, realTarget, etagForStats(stats), fullPath);
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
        indexFileEtag(index, realPath, etagForStats(fs.statSync(fullPath)), fullPath);
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
  index.viteUsesStatLookup = viteUsesStatLookup ?? index.hasSymlink;
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
    if (
      (!index.caseInsensitive && pathHasCaseInsensitiveAlias(filePath)) ||
      (!index.normalizationInsensitive && pathHasNormalizationInsensitiveAlias(filePath))
    ) {
      return false;
    }
    const realPath = toSlash(fs.realpathSync.native(filePath));
    const requestPaths = requestPathsForRealPath(index, filePath, realPath);
    for (const requestPath of requestPaths) {
      indexFileEtag(index, realPath, etagForStats(fs.statSync(filePath)), requestPath);
    }
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
  const supportsFoldedLookup =
    index.viteUsesStatLookup && (index.caseInsensitive || index.normalizationInsensitive);
  let realPath = supportsFoldedLookup ? resolveRequestPath(index, filePath) : undefined;
  filePath = resolveSymlinkTargets(filePath, index.symlinkTargets, index.caseInsensitive);
  realPath ??= supportsFoldedLookup ? resolveRequestPath(index, filePath) : undefined;

  const etag = index.etagsByRealPath.get(realPath ?? filePath);
  return etag && matchesIfNoneMatch(ifNoneMatch, etag) ? etag : undefined;
}

function resolveSymlinkTargets(
  filePath: string,
  targets: ReadonlyMap<string, string>,
  caseInsensitive: boolean,
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
          ? asciiCaseKey(fileSegment) === asciiCaseKey(segment)
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

function indexFileEtag(
  index: DevPublicFileEtagIndex,
  realPath: string,
  etag: string,
  requestPath: string,
): void {
  index.etagsByRealPath.set(realPath, etag);
  indexRequestPath(index, requestPath, realPath);
  for (const alias of verifiedRequestAliases(index, requestPath, realPath)) {
    indexRequestPath(index, alias, realPath);
  }
}

function indexRequestPath(
  index: DevPublicFileEtagIndex,
  requestPath: string,
  realPath: string,
): void {
  const key = requestPathKey(requestPath, index.caseInsensitive);
  const existing = index.requestPathRealPaths.get(key);
  if (existing === undefined || existing === realPath) {
    index.requestPathRealPaths.set(key, realPath);
  } else {
    index.requestPathRealPaths.set(key, null);
  }
}

function indexSymlinkTarget(
  index: DevPublicFileEtagIndex,
  requestPath: string,
  realTarget: string,
): void {
  index.symlinkTargets.set(requestPath, realTarget);
  for (const alias of verifiedRequestAliases(index, requestPath, realTarget)) {
    index.symlinkTargets.set(alias, realTarget);
  }
}

function verifiedRequestAliases(
  index: DevPublicFileEtagIndex,
  requestPath: string,
  realPath: string,
): string[] {
  const relativePath = path.relative(index.publicDir, requestPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return [];

  const segments = relativePath.split("/");
  const aliases: string[] = [];
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    const segment = segments[segmentIndex]!;
    const candidates = new Set<string>();
    if (index.caseInsensitive) {
      candidates.add(segment.toUpperCase());
      candidates.add(segment.toLowerCase());
    }
    if (index.normalizationInsensitive) {
      candidates.add(segment.normalize("NFD"));
      candidates.add(segment.normalize("NFC"));
    }
    for (const candidate of candidates) {
      if (index.caseInsensitive) {
        candidates.add(candidate.toUpperCase());
        candidates.add(candidate.toLowerCase());
      }
    }
    for (const candidate of candidates) {
      if (candidate === segment) continue;
      const aliasSegments = segments.slice();
      aliasSegments[segmentIndex] = candidate;
      const alias = path.join(index.publicDir, aliasSegments.join("/"));
      if (resolvesToSamePath(realPath, alias)) aliases.push(alias);
    }
  }
  return aliases;
}

function requestPathsForRealPath(
  index: DevPublicFileEtagIndex,
  watcherPath: string,
  realPath: string,
): string[] {
  const paths = new Set<string>();
  if (isWithinPublicDir(index.publicDir, watcherPath)) paths.add(watcherPath);
  for (const [source, target] of index.symlinkTargets) {
    if (realPath === target || realPath.startsWith(target + "/")) {
      paths.add(path.join(source, realPath.slice(target.length)));
    }
  }
  return paths.size > 0 ? [...paths] : [realPath];
}

function resolveRequestPath(
  index: DevPublicFileEtagIndex,
  requestPath: string,
): string | undefined {
  const realPath = index.requestPathRealPaths.get(
    requestPathKey(requestPath, index.caseInsensitive),
  );
  return realPath ?? undefined;
}

function detectCaseInsensitiveDirectory(externalDir: string): boolean {
  const dir = toSlash(externalDir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  const entryNames = new Set(entries.map((entry) => entry.name));

  for (const entry of entries) {
    const toggledName = toggleAsciiCase(entry.name);
    if (!toggledName) continue;
    if (entryNames.has(toggledName)) return false;
    if (pathHasCaseInsensitiveAlias(path.join(dir, entry.name))) return true;
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
  const entryNames = new Set(entries.map((entry) => entry.name));

  for (const entry of entries) {
    const alternateName = alternateNormalization(entry.name);
    if (!alternateName) continue;
    if (entryNames.has(alternateName)) return false;
    if (pathHasNormalizationInsensitiveAlias(path.join(dir, entry.name))) {
      return true;
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

function pathHasCaseInsensitiveAlias(filePath: string): boolean {
  const toggledName = toggleAsciiCase(path.basename(filePath));
  return toggledName
    ? resolvesToSamePath(filePath, path.join(path.dirname(filePath), toggledName))
    : false;
}

function pathHasNormalizationInsensitiveAlias(filePath: string): boolean {
  const alternateName = alternateNormalization(path.basename(filePath));
  return alternateName
    ? resolvesToSamePath(filePath, path.join(path.dirname(filePath), alternateName))
    : false;
}

function resolvesToSamePath(left: string, right: string): boolean {
  try {
    return toSlash(fs.realpathSync.native(left)) === toSlash(fs.realpathSync.native(right));
  } catch {
    return false;
  }
}

function requestPathKey(value: string, caseInsensitive: boolean): string {
  return caseInsensitive ? asciiCaseKey(value) : value;
}

function asciiCaseKey(value: string): string {
  return value.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

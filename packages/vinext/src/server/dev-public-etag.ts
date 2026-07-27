import fs from "node:fs";
import path, { toSlash } from "pathslash";
import { hasBasePath, stripBasePath } from "../utils/base-path.js";
import { scanPublicFileRoutes } from "../utils/public-routes.js";
import { matchesIfNoneMatch } from "./http-conditional.js";

export function createDevPublicFileEtags(root: string): Map<string, string> {
  const etags = new Map<string, string>();
  for (const route of scanPublicFileRoutes(root)) {
    updateDevPublicFileEtag(etags, root, path.join(root, "public", route.slice(1)));
  }
  return etags;
}

export function updateDevPublicFileEtag(
  etags: Map<string, string>,
  root: string,
  externalFilePath: string,
  removed = false,
): void {
  const publicDir = path.join(root, "public");
  const relativePath = path.relative(publicDir, toSlash(externalFilePath));
  if (relativePath === "" || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return;
  }

  const route = "/" + relativePath;
  if (removed) {
    etags.delete(route);
    return;
  }

  try {
    const stats = fs.statSync(path.join(publicDir, relativePath));
    if (stats.isFile()) {
      // Vite's public-file middleware delegates to sirv, which uses this
      // size/mtime weak validator in development.
      etags.set(route, `W/"${stats.size}-${stats.mtime.getTime()}"`);
    } else {
      etags.delete(route);
    }
  } catch {
    etags.delete(route);
  }
}

export function resolveDevPublicIfNoneMatch(
  method: string | undefined,
  requestUrl: string | undefined,
  ifNoneMatch: string | string[] | undefined,
  etags: ReadonlyMap<string, string>,
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
    pathname = decodeURI(pathname);
  } catch {
    return undefined;
  }

  const etag = etags.get(pathname);
  return etag && matchesIfNoneMatch(ifNoneMatch, etag) ? etag : undefined;
}

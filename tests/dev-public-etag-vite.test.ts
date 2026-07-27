import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import vinext from "../packages/vinext/src/index.js";

const servers: ViteDevServer[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("dev public ETag Vite configuration", () => {
  it("does not rewrite validators when publicDir is disabled", async () => {
    const root = createRoot();
    const publicDir = path.join(root, "public");
    fs.mkdirSync(publicDir);
    const filePath = path.join(publicDir, "asset.js");
    fs.writeFileSync(filePath, "hello");
    const strong = etagForFile(filePath).replace(/^W\//, "");

    const baseUrl = await startServer(root, false);
    const response = await fetch(`${baseUrl}/asset.js`, {
      headers: { "If-None-Match": strong },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-fallback-if-none-match")).toBe(strong);
    expect(await response.text()).toBe("fallback");
  });

  it("indexes only Vite's resolved custom publicDir", async () => {
    const root = createRoot();
    const defaultPublicDir = path.join(root, "public");
    const customPublicDir = path.join(root, "custom-public");
    fs.mkdirSync(defaultPublicDir);
    fs.mkdirSync(customPublicDir);
    const defaultFile = path.join(defaultPublicDir, "root-only.js");
    fs.writeFileSync(defaultFile, "wrong");
    fs.writeFileSync(path.join(customPublicDir, "asset.js"), "custom");

    const baseUrl = await startServer(root, "custom-public");
    const initial = await fetch(`${baseUrl}/asset.js`);
    expect(initial.status).toBe(200);
    expect(await initial.text()).toBe("custom");
    const etag = initial.headers.get("etag");
    expect(etag).toMatch(/^W\//);

    const conditional = await fetch(`${baseUrl}/asset.js`, {
      headers: { "If-None-Match": etag!.replace(/^W\//, "") },
    });
    expect(conditional.status).toBe(304);

    const rootOnlyStrong = etagForFile(defaultFile).replace(/^W\//, "");
    const fallback = await fetch(`${baseUrl}/root-only.js`, {
      headers: { "If-None-Match": rootOnlyStrong },
    });
    expect(fallback.status).toBe(200);
    expect(fallback.headers.get("x-fallback-if-none-match")).toBe(rootOnlyStrong);
    expect(await fallback.text()).toBe("fallback");
  });

  it.runIf(process.platform === "darwin")(
    "matches case and normalization aliases when a dangling symlink enables Vite stat lookup",
    async () => {
      const root = createRoot();
      const publicDir = path.join(root, "public");
      fs.mkdirSync(publicDir);
      const mixedCaseFile = path.join(publicDir, "MixedCase.js");
      const unicodeFile = path.join(publicDir, "Éclair.js");
      fs.writeFileSync(mixedCaseFile, "mixed");
      fs.writeFileSync(unicodeFile, "unicode");
      fs.symlinkSync("missing", path.join(publicDir, "0-broken"));

      const lowerCaseFile = path.join(publicDir, "mixedCase.js");
      if (fs.realpathSync.native(mixedCaseFile) !== fs.realpathSync.native(lowerCaseFile)) return;

      const baseUrl = await startServer(root, "public");
      const mixedEtag = (await fetch(`${baseUrl}/MixedCase.js`)).headers.get("etag");
      expect(mixedEtag).toMatch(/^W\//);
      expect(
        (
          await fetch(`${baseUrl}/mixedcase.js`, {
            headers: { "If-None-Match": mixedEtag!.replace(/^W\//, "") },
          })
        ).status,
      ).toBe(304);

      const unicodeEtag = (await fetch(`${baseUrl}/%C3%89clair.js`)).headers.get("etag");
      expect(unicodeEtag).toMatch(/^W\//);
      expect(
        (
          await fetch(`${baseUrl}/%C3%A9clair.js`, {
            headers: { "If-None-Match": unicodeEtag!.replace(/^W\//, "") },
          })
        ).status,
      ).toBe(304);

      const decomposedFile = path.join(publicDir, "E\u0301clair.js");
      if (fs.realpathSync.native(unicodeFile) === fs.realpathSync.native(decomposedFile)) {
        expect(
          (
            await fetch(`${baseUrl}/E%CC%81clair.js`, {
              headers: { "If-None-Match": unicodeEtag!.replace(/^W\//, "") },
            })
          ).status,
        ).toBe(304);
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not fold or rewrite a wrong-case request for a symlinked public root",
    async () => {
      const root = createRoot();
      const actualPublicDir = path.join(root, "actual-public");
      const publicDir = path.join(root, "public");
      fs.mkdirSync(actualPublicDir);
      fs.writeFileSync(path.join(actualPublicDir, "MixedCase.js"), "content");
      fs.symlinkSync(actualPublicDir, publicDir, "dir");

      const baseUrl = await startServer(root, "public");
      const initial = await fetch(`${baseUrl}/MixedCase.js`);
      const strong = initial.headers.get("etag")!.replace(/^W\//, "");
      const fallback = await fetch(`${baseUrl}/mixedcase.js`, {
        headers: { "If-None-Match": strong },
      });

      expect(fallback.status).toBe(200);
      expect(fallback.headers.get("x-fallback-if-none-match")).toBe(strong);
      expect(await fallback.text()).toBe("fallback");
    },
  );
});

function createRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-dev-public-config-"));
  roots.push(root);
  return root;
}

async function startServer(root: string, publicDir: string | false): Promise<string> {
  const fallbackPlugin: Plugin = {
    name: "test-public-etag-fallback",
    configureServer(server) {
      return () => {
        server.middlewares.use((req, res) => {
          const validator = req.headers["if-none-match"];
          if (typeof validator === "string") {
            res.setHeader("x-fallback-if-none-match", validator);
          }
          res.statusCode = 200;
          res.end("fallback");
        });
      };
    },
  };

  const server = await createServer({
    root,
    publicDir,
    configFile: false,
    plugins: [vinext(), fallbackPlugin],
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
  });
  servers.push(server);
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP dev server");
  return `http://127.0.0.1:${address.port}`;
}

function etagForFile(filePath: string): string {
  const stats = fs.statSync(filePath);
  return `W/"${stats.size}-${stats.mtime.getTime()}"`;
}

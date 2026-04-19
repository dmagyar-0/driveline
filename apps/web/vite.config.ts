import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import { resolve } from "node:path";

const SAMPLE_DATA_DIR = resolve(__dirname, "../../sample-data");

export default defineConfig({
  plugins: [
    react(),
    wasm(),
    topLevelAwait(),
    // Serve the T0.3 sample corpus under `/sample-data/*` for the e2e
    // suite so specs can `fetch()` bytes into the page instead of
    // ping-ponging tens of MB through CDP JSON serialisation.
    {
      name: "driveline-sample-data",
      configureServer(server) {
        server.middlewares.use("/sample-data", async (req, res, next) => {
          try {
            const url = req.url ?? "/";
            const rel = decodeURIComponent(url.split("?")[0]).replace(
              /^\/+/,
              "",
            );
            if (!rel || rel.includes("..")) {
              res.statusCode = 400;
              res.end("bad path");
              return;
            }
            const full = resolve(SAMPLE_DATA_DIR, rel);
            if (!full.startsWith(SAMPLE_DATA_DIR)) {
              res.statusCode = 400;
              res.end("bad path");
              return;
            }
            const { createReadStream, statSync } = await import("node:fs");
            const stat = statSync(full);
            res.setHeader("Content-Type", "application/octet-stream");
            res.setHeader("Content-Length", stat.size);
            createReadStream(full).pipe(res);
          } catch {
            next();
          }
        });
      },
    },
  ],
  worker: {
    format: "es",
    plugins: () => [wasm(), topLevelAwait()],
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["src/tests/e2e/**", "**/node_modules/**"],
  },
});

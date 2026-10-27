import path from "node:path";
import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  resolve: {
    alias: {
      $lib: path.resolve("./src/lib"),
    },
  },
  build: {
    // marked + the highlight.js grammars in $lib/highlight.ts put the single
    // bundle past Vite's 500 kB default. It is one self-hosted local app, so
    // code-splitting it would trade a warning for a loading waterfall.
    chunkSizeWarningLimit: 700,
  },
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: "ws://127.0.0.1:8787", ws: true },
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "happy-dom",
    server: { deps: { inline: ["svelte"] } },
  },
});

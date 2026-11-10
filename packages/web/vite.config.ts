import path from "node:path";
import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

/** absolute path to one of svelte's browser entry points, resolved beside this config */
const svelteClient = (file: string) => path.resolve("./node_modules/svelte/src", file);

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
    // bind all interfaces so the dev UI is reachable from other machines
    host: "0.0.0.0",
    // hostnames (not just IPs) are rejected by default; allow anything
    allowedHosts: true,
    port: 5173,
    proxy: {
      "/ws": { target: "ws://127.0.0.1:8787", ws: true },
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "happy-dom",
    server: { deps: { inline: ["svelte"] } },
    // tests run in happy-dom, but Vitest resolves through node/ssr conditions, so
    // `svelte` lands on the server build and `mount` throws. Alias just the
    // browser entry points the tests use — test-scoped, so the build keeps Vite's
    // default (browser) resolve conditions.
    alias: [
      { find: /^svelte$/, replacement: svelteClient("index-client.js") },
      { find: /^svelte\/reactivity$/, replacement: svelteClient("reactivity/index-client.js") },
    ],
  },
});

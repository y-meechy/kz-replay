import { defineConfig } from "vite";
import { resolve } from "node:path";
import { convertMapPlugin } from "./convertMapPlugin.js";
import { viewsPlugin } from "./viewsPlugin.js";

// The viewer imports src/track.js from the repo root (the decoder is shared with
// the CLI so the two can never disagree), so the dev server has to be allowed to
// read one level above its own root.
const here = import.meta.dirname;

export default defineConfig({
  root: here,
  plugins: [convertMapPlugin(), viewsPlugin()],
  server: {
    port: 5180,
    fs: { allow: [resolve(here, "..")] },
    proxy: {
      // api.cs2kz.org sends CORS headers, so it is called directly. The replay
      // bucket sends none, so the browser cannot fetch it and the dev server has
      // to pass it through. A deployed viewer needs the same one-line proxy
      // somewhere server side.
      "/replay": {
        target: "https://replays.cs2kz.org",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/replay/, ""),
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // main.js boots with a top level await, which the default target rejects.
    target: "es2022",
  },
});

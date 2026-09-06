import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(import.meta.dirname, ".."),
  plugins: [
    {
      name: "fidelity-character-route",
      configureServer(server) {
        server.middlewares.use((request, _response, next) => {
          if (request.url === "/scripts/models/ct.glb")
            request.url = "/viewer/public/models/ct.glb";
          next();
        });
      },
    },
  ],
  server: {
    // Restart this dedicated server between source revisions. Captures must not
    // reload halfway through when another task edits the viewer.
    watch: null,
    hmr: false,
    host: "127.0.0.1",
    port: 5181,
    fs: { allow: [resolve(import.meta.dirname, "../..")] },
  },
});

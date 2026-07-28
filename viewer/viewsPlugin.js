// The view counter, on the dev server.
//
// Same handler the deployed server mounts, so /api/views behaves identically in
// development and there is one implementation of counting rather than two. The
// counts land in .state/views.json at the repo root, which is git-ignored: a
// development machine's numbers are nobody's business.

import { createViewCounter, handleViewsRequest } from "../src/views.js";

export const viewsPlugin = () => ({
  name: "kz-views",
  configureServer(server) {
    const counter = createViewCounter({
      log: (message) => server.config.logger.info(`views: ${message}`),
    });

    server.middlewares.use("/api/views", async (request, response, next) => {
      // Vite strips the mount path off request.url, so the handler is given the
      // full path back: it routes on /api/views itself.
      const url = request.originalUrl ?? request.url ?? "";
      const handled = await handleViewsRequest(
        Object.assign(request, { url }),
        response,
        counter,
      );
      if (!handled) next();
    });
  },
});

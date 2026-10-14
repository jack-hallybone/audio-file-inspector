import { defineConfig } from "vite";

// The shipped CSP denies connections outright, blocking dev's hot-reload websocket, so this loosens it only in `vite`'s dev server — never prod or `vite preview`.
const devCsp = () => ({
  name: "dev-csp",
  apply: "serve",
  transformIndexHtml: (html) =>
    html.replace("connect-src 'none'", "connect-src 'self' ws: wss:"),
});

// Chromium fails hard-nav to a non-2xx response with an empty body; the deferred hook form matters so this plugin's res.end wrap ends up innermost.
const realNotFoundBody = () => {
  const install = (server) => () => {
    server.middlewares.use((req, res, next) => {
      const end = res.end.bind(res);
      res.end = (chunk, ...rest) => {
        if (res.statusCode === 404 && !res.headersSent && !chunk?.length) {
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          return end("not found", ...rest);
        }
        return end(chunk, ...rest);
      };
      next();
    });
  };
  return {
    name: "real-404-body",
    configureServer: install,
    configurePreviewServer: install,
  };
};

export default defineConfig({
  // index.html lives in src/, alongside every other served file.
  root: "src",
  // This app has no routes: any navigation besides "/" is a bad link, and Workbox's navigateFallbackDenylist only works if the origin server agrees.
  appType: "mpa",
  plugins: [devCsp(), realNotFoundBody()],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  // build.mjs (not `vite build`) fills dist/; this is kept only so `vite preview` knows where to serve from.
  build: { outDir: "../dist" },
});

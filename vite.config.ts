import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

// The editor is a single-page app. It builds to dist/, which the Worker serves as static assets.
export default defineConfig({
  root: "web",
  plugins: [preact()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});

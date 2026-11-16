import { readFileSync } from "node:fs";
import preact from "@preact/preset-vite";
import { defineConfig, type Plugin } from "vite";

// The 404 page of a student site is not part of the editor's build, so it cannot know the hashed
// font file. This copies the font to a fixed path; the Worker serves it there with CORS.
const fixedFont: Plugin = {
  name: "fixed-font",
  generateBundle() {
    this.emitFile({
      type: "asset",
      fileName: "fonts/atkinson-hyperlegible-next.woff2",
      source: readFileSync(
        "node_modules/@fontsource-variable/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-wght-normal.woff2",
      ),
    });
  },
};

// The editor is a single-page app. It builds to dist/, which the Worker serves as static assets.
export default defineConfig({
  root: "web",
  plugins: [preact(), fixedFont],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    sourcemap: true,
  },
});

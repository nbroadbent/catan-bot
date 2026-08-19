import { defineConfig } from "vite";

// Bundles the content script into a single IIFE file the extension can load.
export default defineConfig({
  build: {
    outDir: "extension",
    emptyOutDir: false,
    lib: {
      entry: "src/extension/content.ts",
      name: "CatanCopilot",
      formats: ["iife"],
      fileName: () => "content.js",
    },
    minify: false,
  },
  test: {
    environment: "jsdom",
  },
} as never);

import { defineConfig } from "vite";

// Second bundle: the page-world WebSocket tap.
export default defineConfig({
  build: {
    outDir: "extension",
    emptyOutDir: false,
    lib: {
      entry: "src/extension/inject.ts",
      name: "CatanCopilotInject",
      formats: ["iife"],
      fileName: () => "inject.js",
    },
    minify: false,
  },
});

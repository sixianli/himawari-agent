import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { pdfjsAssets } from "./vite-pdfjs-assets.js";

export default defineConfig({
  build: {
    cssCodeSplit: true,
    modulePreload: { polyfill: false },
    sourcemap: false,
  },
  plugins: [react(), pdfjsAssets()],
});

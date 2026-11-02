import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { resolveBuildInfo } from "./build-info.mjs";

export default defineConfig({
  build: {
    cssCodeSplit: true,
    modulePreload: { polyfill: false },
    sourcemap: false,
  },
  define: {
    __HIMAWARI_BUILD__: JSON.stringify(resolveBuildInfo(process.env)),
  },
  plugins: [react()],
});

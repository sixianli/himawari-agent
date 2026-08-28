import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    cssCodeSplit: true,
    modulePreload: { polyfill: false },
    sourcemap: false,
  },
  plugins: [react()],
});

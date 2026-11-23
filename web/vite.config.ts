import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  build: {
    // Served by `pb-tokei annotate` (FastAPI), which finds it beside its own module.
    outDir: "../src/pb_tokei/annotate/static",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    // `bun run dev` serves the front end; the API comes from `pb-tokei annotate --no-browser`.
    proxy: { "/api": "http://127.0.0.1:8000" },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});

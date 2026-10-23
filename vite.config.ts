import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist/client" },
  server: { proxy: { "/api": "http://127.0.0.1:3001" } },
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    testTimeout: 15000,
  },
} as any);

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Same-origin API in dev: Vite proxies to the `api` compose service (Docker-only
// rule — service names, never localhost, for cross-service traffic).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": { target: "http://api:3000", changeOrigin: true },
      "/socket.io": { target: "http://api:3000", ws: true },
    },
  },
});

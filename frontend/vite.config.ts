import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/health": "http://localhost:3000",
      "/auth": "http://localhost:3000",
      "/executors": "http://localhost:3000",
      "/tasks": "http://localhost:3000",
      "/bids": "http://localhost:3000",
      "/executor": "http://localhost:3000",
      "/admin": "http://localhost:3000",
      "/feed": "http://localhost:3000",
      "/metrics": "http://localhost:3000",
    },
  },
});

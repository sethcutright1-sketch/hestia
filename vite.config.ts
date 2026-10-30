import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vite";

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { "@": path.resolve(__dirname, ".") },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== "true",
      // File watching off during agent edits, to stop the page flickering.
      watch: process.env.DISABLE_HMR === "true" ? null : {},
      // Lets the household reach the dev server over Tailscale from a phone.
      // Vite blocks unknown hostnames by default as a DNS-rebinding guard.
      allowedHosts: ["your-host.your-tailnet.ts.net"],
    },
  };
});

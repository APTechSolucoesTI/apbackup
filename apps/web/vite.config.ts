import { defineConfig } from 'vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { nitro } from 'nitro/vite';
// The public auth origin is also the local console origin; a legacy health PORT must not split cookies/origins.
const consolePort = Number(
  new URL(process.env.AUTH_BASE_URL ?? 'http://127.0.0.1:4320').port || 4320,
);
process.env.PORT = String(consolePort);
export default defineConfig({
  plugins: [tailwindcss(), tanstackStart(), react(), nitro({ preset: 'node-server' })],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { host: '127.0.0.1', port: consolePort, strictPort: true },
});

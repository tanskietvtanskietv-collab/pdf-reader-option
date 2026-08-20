import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(({ mode }) => {
  // loadEnv reads client/.env* AND VITE_-prefixed shell variables. A bare
  // `process.env.VITE_API_TARGET` would only ever see the shell ones.
  const env = loadEnv(mode, here, 'VITE_');

  return {
    plugins: [vue()],
    server: {
      port: 5173,
      // Fail instead of silently sliding to 5174 when the port is taken —
      // a moved port is the usual reason /api suddenly 404s in the browser.
      strictPort: true,
      // The proxy runs inside this dev server, so the target is always reached
      // over loopback. Never put the machine's LAN IP here: it breaks the moment
      // DHCP hands out a new lease. To let other devices reach the *client*, set
      // VITE_DEV_HOST=0.0.0.0 instead — that is what LAN exposure needs.
      host: env.VITE_DEV_HOST || false,
      proxy: {
        '/api': {
          target: env.VITE_API_TARGET || 'http://127.0.0.1:3000',
          changeOrigin: true,
        },
      },
    },
    build: { outDir: 'dist', emptyOutDir: true },
  };
});

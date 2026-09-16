import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  // Keep HTML's pre-paint defaults and React's environment defaults identical.
  const appearance = {
    VITE_TARDIS_STYLE: env.VITE_TARDIS_STYLE === 'lavender' ? 'lavender' : 'console',
    VITE_TARDIS_THEME: env.VITE_TARDIS_THEME === 'light' ? 'light' : 'dark',
  };
  return {
    define: Object.fromEntries(Object.entries(appearance).map(([key, value]) => [`import.meta.env.${key}`, JSON.stringify(value)])),
    plugins: [react(), tailwindcss(), {
      name: 'tardis-appearance-defaults',
      transformIndexHtml: {
        order: 'pre',
        handler: (html) => html.replace(/%VITE_TARDIS_(STYLE|THEME)%/g, (_, key: 'STYLE' | 'THEME') => appearance[`VITE_TARDIS_${key}`]),
      },
    }],
    server: {
      proxy: {
        '/api': {
          target: 'http://localhost:8091',
          changeOrigin: true,
          ws: true,
        },
        '/ws/scribe': {
          target: 'ws://localhost:8091',
          ws: true,
        },
        '/ws/voice': {
          target: 'ws://localhost:8091',
          ws: true,
        },
      },
    },
  };
});

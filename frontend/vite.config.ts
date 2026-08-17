import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: {
    outDir: '../web/dist',
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'xterm',
              test: /node_modules[\\/]@xterm[\\/]/,
              priority: 3,
            },
            {
              name: 'react',
              test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
              priority: 2,
            },
            {
              name: 'icons',
              test: /node_modules[\\/]lucide-react[\\/]/,
              priority: 1,
            },
          ],
        },
      },
    },
  },
});

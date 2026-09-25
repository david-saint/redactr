import { defineConfig, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { VitePWA } from "vite-plugin-pwa";
import wasm from "vite-plugin-wasm";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

/**
 * Serve PDF.js data files (CMaps, standard fonts, image-decoder WASM, ICC
 * profiles) from the app itself under `pdfjs/`, so PDFs render fully offline
 * without fetching anything from a CDN.
 */
function pdfjsAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const pdfjsRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
  const dirs = ["cmaps", "standard_fonts", "wasm", "iccs"];
  // Scripting support is disabled, so its sandbox runtime is not needed.
  const isNeeded = (file: string) =>
    !file.startsWith("quickjs") && !file.startsWith("LICENSE");

  return {
    name: "pdfjs-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const base = server.config.base;
        const url = decodeURIComponent((req.url ?? "").split("?")[0]);
        const match = url.startsWith(`${base}pdfjs/`)
          ? /^([a-z_]+)\/([\w.-]+)$/.exec(url.slice(`${base}pdfjs/`.length))
          : null;
        if (!match || !dirs.includes(match[1]) || !isNeeded(match[2])) {
          return next();
        }
        const file = path.join(pdfjsRoot, match[1], match[2]);
        if (!fs.existsSync(file)) return next();
        if (file.endsWith(".wasm")) {
          res.setHeader("Content-Type", "application/wasm");
        }
        fs.createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const dir of dirs) {
        for (const file of fs.readdirSync(path.join(pdfjsRoot, dir))) {
          if (!isNeeded(file)) continue;
          this.emitFile({
            type: "asset",
            fileName: `pdfjs/${dir}/${file}`,
            source: fs.readFileSync(path.join(pdfjsRoot, dir, file)),
          });
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [
    svelte(),
    wasm(),
    pdfjsAssets(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "robots.txt"],
      manifest: {
        name: "Redactr",
        short_name: "Redactr",
        description: "Privacy-focused image redaction tool",
        theme_color: "#1a1a1a",
        background_color: "#1a1a1a",
        display: "standalone",
        icons: [
          {
            src: "pwa-192x192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
          },
          {
            src: "pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,mjs,css,html,svg,png,wasm}"],
        // PDF.js data files are only needed for some PDFs; cache on first use
        // instead of precaching several MB for every visitor.
        globIgnores: ["pdfjs/**"],
        runtimeCaching: [
          {
            urlPattern: ({ url, sameOrigin }) =>
              sameOrigin && url.pathname.includes("/pdfjs/"),
            handler: "CacheFirst",
            options: {
              cacheName: "pdfjs-data",
              expiration: {
                maxEntries: 300,
                maxAgeSeconds: 90 * 24 * 60 * 60,
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
          {
            // Cache MediaPipe WASM and model files
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/npm\/@mediapipe/,
            handler: "CacheFirst",
            options: {
              cacheName: "mediapipe-wasm",
              expiration: {
                maxEntries: 20,
                maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
          {
            // Cache MediaPipe models from Google Storage
            urlPattern: /^https:\/\/storage\.googleapis\.com\/mediapipe-models/,
            handler: "CacheFirst",
            options: {
              cacheName: "mediapipe-models",
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
          {
            // Cache Transformers.js models from CDN
            urlPattern:
              /^https:\/\/cdn\.jsdelivr\.net\/npm\/@xenova\/transformers/,
            handler: "CacheFirst",
            options: {
              cacheName: "ml-models-transformers",
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
          {
            // Cache Hugging Face model files
            urlPattern: /^https:\/\/huggingface\.co\/.*\.(onnx|json|bin)$/,
            handler: "CacheFirst",
            options: {
              cacheName: "ml-models-hf",
              expiration: {
                maxEntries: 30,
                maxAgeSeconds: 30 * 24 * 60 * 60,
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
          {
            // Cache Tesseract.js trained data
            urlPattern: /^https:\/\/tessdata\.projectnaptha\.com/,
            handler: "CacheFirst",
            options: {
              cacheName: "tesseract-data",
              expiration: {
                maxEntries: 10,
                maxAgeSeconds: 30 * 24 * 60 * 60,
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
          {
            // Cache ONNX runtime files
            urlPattern: /\.onnx$/,
            handler: "CacheFirst",
            options: {
              cacheName: "onnx-models",
              expiration: {
                maxEntries: 20,
                maxAgeSeconds: 30 * 24 * 60 * 60,
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
        ],
      },
    }),
  ],
  optimizeDeps: {
    exclude: ["redactr-wasm"],
  },
});

import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { VitePWA } from "vite-plugin-pwa";
import wasm from "vite-plugin-wasm";

export default defineConfig({
  plugins: [
    svelte(),
    wasm(),
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
        globPatterns: ["**/*.{js,css,html,svg,png,wasm}"],
        runtimeCaching: [
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

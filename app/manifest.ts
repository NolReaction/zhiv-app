import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Я живой",
    short_name: "Я живой",
    description: "Одна кнопка, чтобы близкие знали: вы живы и на связи.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#11140f",
    theme_color: "#11140f",
    lang: "ru-RU",
    orientation: "any",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}

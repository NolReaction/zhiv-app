import type { MetadataRoute } from "next";
import { BRAND_ICON_192_SRC, BRAND_ICON_512_SRC, BRAND_MASKABLE_ICON_SRC } from "@/lib/brand-assets";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Я Живой",
    short_name: "Я Живой",
    description: "Будьте на связи с близкими и обживайте уютный лесной мир Мохлика.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#11140f",
    theme_color: "#11140f",
    lang: "ru-RU",
    orientation: "any",
    icons: [
      {
        src: BRAND_ICON_192_SRC,
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: BRAND_ICON_512_SRC,
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: BRAND_MASKABLE_ICON_SRC,
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}

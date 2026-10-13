import type { Metadata, Viewport } from "next";
import media from "@/public/site/media.json";
import { ProductSite } from "@/features/site/product-site";

export const metadata: Metadata = {
  title: "Я живой. близкие рядом, целый лес в кармане",
  description: "Сообщайте близким, что всё хорошо, и обживайте уютный мир Мохлика. Играйте на компьютере или установите «Я живой» на телефон.",
  alternates: { canonical: "https://im-alive.ru/site" },
  openGraph: {
    title: "Я живой. маленькая отметка. Большой тёплый мир.",
    description: "Близкие спокойны. А у тебя целый лес. Знакомство с приложением и установка на своё устройство.",
    url: "https://im-alive.ru/site", type: "website", locale: "ru_RU",
    images: [{ url: `https://im-alive.ru${media.poster.src}`, width: media.poster.width, height: media.poster.height, alt: "Лесная полянка в игре «Я живой»" }],
  },
};

export const viewport: Viewport = {
  width: "device-width", initialScale: 1, minimumScale: 1, maximumScale: 5,
  userScalable: true, viewportFit: "cover", themeColor: "#101f1a",
};

export default function SitePage() { return <ProductSite />; }

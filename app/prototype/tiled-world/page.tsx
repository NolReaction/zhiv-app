import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TiledWorldPreview } from "@/features/world/tiled/tiled-world-preview";

export const metadata: Metadata = {
  title: "Мир Мохлика — проверка карты",
  robots: { index: false, follow: false },
};

export default function TiledWorldPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <TiledWorldPreview />;
}

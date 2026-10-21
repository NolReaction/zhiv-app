import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EarthModelPreview } from "@/features/earth/dev/earth-model-preview";

export const metadata: Metadata = { title: "Земля: редактор 3D-моделей", robots: { index: false, follow: false } };

export default function EarthModelsPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <EarthModelPreview />;
}

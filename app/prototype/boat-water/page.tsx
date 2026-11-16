import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BoatWaterPreview } from "@/features/economy/dev/boat-water-preview";

export const metadata: Metadata = {
  title: "Проверка плавания · Мохлик",
  robots: { index: false, follow: false },
};

export default function BoatWaterPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <BoatWaterPreview />;
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PhaserWorldLab } from "@/features/world/phaser/phaser-world-lab";

export const metadata: Metadata = {
  title: "Мир Мохлика — лаборатория Phaser",
  robots: { index: false, follow: false },
};

export default function PhaserWorldPage() {
  if (process.env.NODE_ENV !== "development" && process.env.PHASER_LAB_ENABLED !== "1") notFound();
  return <PhaserWorldLab />;
}

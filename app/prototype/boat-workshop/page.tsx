import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BoatWorkshopPreview } from "@/features/economy/dev/boat-workshop-preview";

export const metadata: Metadata = {
  title: "Лодочная мастерская · демо",
  robots: { index: false, follow: false },
};

export default function BoatWorkshopPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <BoatWorkshopPreview />;
}

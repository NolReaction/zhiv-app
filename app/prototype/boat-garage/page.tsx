import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { GarageEditor } from "@/features/world/dev/boat-garage/garage-editor";

export const metadata: Metadata = {
  title: "Сборщик лодки · Мохлик",
  robots: { index: false, follow: false },
};

export default function BoatGaragePage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <GarageEditor />;
}

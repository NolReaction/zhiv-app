import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TradeShipPreview } from "@/features/world/dev/trade-ship-preview";

export const metadata: Metadata = {
  title: "Торговый пароход · Мохлик",
  robots: { index: false, follow: false },
};

export default function TradeShipPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <TradeShipPreview />;
}

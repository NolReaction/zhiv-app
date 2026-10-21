import type { Metadata, Viewport } from "next";
import { BranchPage } from "@/features/progression/branch-page";

export const metadata: Metadata = {
  title: "Дерево развития мира · Я живой",
  description: "Дерево развития мира Мохлика: все ингредиенты, рецепты, производственные цепочки, расчёты экономики, постройки и торговля.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  viewportFit: "cover",
  themeColor: "#171d16",
};

export default function ProgressionPage() {
  return <BranchPage />;
}

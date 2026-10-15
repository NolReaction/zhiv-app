import type { Metadata } from "next";
import { ProceduralForestPreview } from "@/apps/engine/src/editor/ui/procedural-forest-preview";

export const metadata: Metadata = {
  title: "Лес из кода · Мохлик",
  robots: { index: false, follow: false },
};

export default function ProceduralForestPage() {
  return <ProceduralForestPreview backLink={{ href: "/", label: "В приложение" }}
    sampleImage={{ url: "/world/prototype/home-level-1.png", fileName: "home-level-1.png", label: "Дом 1 уровня" }} />;
}

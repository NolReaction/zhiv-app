import type { Metadata } from "next";
import { ProceduralForestPreview } from "@/features/world/dev/procedural-forest/ui/procedural-forest-preview";

export const metadata: Metadata = {
  title: "Лес из кода · Мохлик",
  robots: { index: false, follow: false },
};

export default function ProceduralForestPage() {
  return <ProceduralForestPreview />;
}

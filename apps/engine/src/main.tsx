import { createRoot } from "react-dom/client";
import { ProceduralForestPreview } from "./editor/ui/procedural-forest-preview";
import "./app.css";

const root = document.getElementById("root");
if (!root) throw new Error("Engine root element is missing.");

createRoot(root).render(<ProceduralForestPreview
  documentTitle="Engine · Экспериментальный редактор"
  sampleImage={{ url: "/examples/forest/home-level-1.png", fileName: "home-level-1.png", label: "Дом 1 уровня" }}
/>);

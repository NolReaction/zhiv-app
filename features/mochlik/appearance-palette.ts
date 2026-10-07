type MossPalette = { moss: string; mossLight: string; mossDark: string };

/** Shared by the cached body and the hands drawn by interaction painters. */
const palettes: Record<string, MossPalette> = {
  moss: { moss: "#7c8845", mossLight: "#a5ad58", mossDark: "#58683b" },
  fern: { moss: "#49816b", mossLight: "#7fb99a", mossDark: "#345649" },
  autumn: { moss: "#b27b42", mossLight: "#d8ae63", mossDark: "#7a5637" },
  heather: { moss: "#8a739b", mossLight: "#baa3c7", mossDark: "#62536e" },
  frost: { moss: "#8ba9a3", mossLight: "#c3d7c9", mossDark: "#587b76" },
  ember: { moss: "#a96750", mossLight: "#d59b6f", mossDark: "#764936" },
};

export function mossPalette(id?: string): MossPalette {
  return id && Object.hasOwn(palettes, id) ? palettes[id] : palettes.moss;
}

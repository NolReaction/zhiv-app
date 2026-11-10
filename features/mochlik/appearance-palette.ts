type MossPalette = { moss: string; mossLight: string; mossDark: string };

/** Shared by the cached body and the hands drawn by interaction painters. */
const palettes: Record<string, MossPalette> = {
  moss: { moss: "#7c8845", mossLight: "#a5ad58", mossDark: "#58683b" },
  fern: { moss: "#49816b", mossLight: "#7fb99a", mossDark: "#345649" },
  autumn: { moss: "#b27b42", mossLight: "#d8ae63", mossDark: "#7a5637" },
  berest_birch_moss: { moss: "#6a8f7c", mossLight: "#c6cba0", mossDark: "#365b4f" },
  heather: { moss: "#8a739b", mossLight: "#baa3c7", mossDark: "#62536e" },
  frost: { moss: "#8ba9a3", mossLight: "#c3d7c9", mossDark: "#587b76" },
  ember: { moss: "#a96750", mossLight: "#d59b6f", mossDark: "#764936" },
  dune_moss: { moss: "#b7a875", mossLight: "#e0d3a0", mossDark: "#80754f" },
  storm_moss: { moss: "#687b91", mossLight: "#a6bbcd", mossDark: "#465668" },
  premium_stargazer_moss: { moss: "#525984", mossLight: "#9b9ed1", mossDark: "#353955" },
  premium_ember_moss: { moss: "#ad6048", mossLight: "#eda773", mossDark: "#733f3a" },
  premium_explorer_moss: { moss: "#638879", mossLight: "#a8c6a0", mossDark: "#3a5d55" },
};

export function mossPalette(id?: string): MossPalette {
  return id && Object.hasOwn(palettes, id) ? palettes[id] : palettes.moss;
}

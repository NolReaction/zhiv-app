import type { ButtonHTMLAttributes } from "react";

// Firefox otherwise restores dynamic disabled state before React hydrates.
// Keep native button guards; opt out statically in SSR and the first render.
const noStateRestore = { autoComplete: "off" } as const;

export function EditorButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} {...noStateRestore} />;
}

/** Quiet, decorative map drawings. They never carry information or intercept taps. */
export function ExpeditionActivityArt({ sector }: { sector: "forest" | "shore" | "caves" }) {
  return <svg viewBox="0 0 150 130" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" data-activity-art={sector}>
    {sector === "forest" ? <>
      <path d="M41 143c-24-34 52-26 47-55S55 63 68 30" strokeDasharray="3 6" opacity=".45" />
      <path d="m109 11-16 26h9L85 63h16L82 88h51l-19-25h16l-16-26h9Z" fill="currentColor" fillOpacity=".06" /><path d="M108 88v20m-47-61L48 68h8L41 90h34L61 68h8Z" /><path d="M59 90v15" />
      <path d="M132 111c-25-8-16-31-16-31s24 7 16 31Zm0 0-12-23M25 42C1 39 7 15 7 15s25 2 18 27Zm0 0L12 22M145 43c-18 1-17-17-17-17s20-2 17 17Z" fill="currentColor" fillOpacity=".1" />
      <path d="M16 91h7m-4-4v8m111-84h5m-2-3v6" opacity=".5" />
    </> : sector === "shore" ? <>
      <ellipse cx="121" cy="10" rx="44" ry="29" opacity=".4" /><ellipse cx="121" cy="10" rx="58" ry="41" opacity=".25" /><ellipse cx="121" cy="10" rx="72" ry="53" opacity=".15" />
      <g transform="translate(51 58) rotate(-15)"><path d="M0 0c12-15 36-15 47 0C36 15 12 15 0 0Zm0 0-13-10v20Z" fill="currentColor" fillOpacity=".07" /><path d="M32-10c-5 5-5 15 0 20m-14-22 5-6 7 5m-12 24 6 5 5-4" /><circle cx="37" cy="-1" r="1.2" fill="currentColor" stroke="none" /></g>
      <g transform="translate(119 99) rotate(162) scale(.63)"><path d="M0 0c12-15 36-15 47 0C36 15 12 15 0 0Zm0 0-13-10v20Z" /><path d="M32-10c-5 5-5 15 0 20" /><circle cx="37" r="1.5" fill="currentColor" stroke="none" /></g>
      <path d="M21 107q9-5 18 0t18 0M8 118q9-5 18 0t18 0m93-64h5m-2-3v6" opacity=".5" /><circle cx="38" cy="34" r="3" opacity=".4" />
    </> : <>
      <path d="m25 31 34-17 32 11 27-13 32 7M19 43l40-17 31 13 29-15 31 8M16 56l41-14 32 10 32-13 29 9M20 116l37-14 40 13 53-17M36 127l23-13 40 12 51-15" opacity=".25" />
      <path d="m78 36 18 19-3 47-20 8-18-17 4-43Zm0 0-4 27-19 30m19-30 22-8M74 63l-1 47" fill="currentColor" fillOpacity=".06" />
      <path d="m117 68 17 12-3 26-15 9-12-14 2-23Zm0 0-2 22-11 11m11-11 19-10m-19 10 1 25" fill="currentColor" fillOpacity=".12" />
      <path d="m40 63 2 6 6 2-6 2-2 6-2-6-6-2 6-2Zm77-27 2 6 6 2-6 2-2 6-2-6-6-2 6-2Z" /><path d="M40 99h5m-2-3v6" opacity=".5" />
    </>}
  </svg>;
}

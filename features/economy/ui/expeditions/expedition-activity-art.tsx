/** Quiet, decorative map drawings. They never carry information or intercept taps. */
export function ExpeditionActivityArt({ sector }: { sector: "forest" | "shore" | "caves" }) {
  return <svg viewBox="0 0 150 130" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" data-activity-art={sector}>
    {sector === "forest" ? <>
      <path d="M-8 114c18-23 34-19 54-42 24-28 31-20 47-29 26-15 40-16 70-44v144H-8Z" fill="#486044" stroke="none" />
      <path d="M11 120c35-37 50-20 80-51 25-25 48-28 70-36v110H11Z" fill="#354b39" stroke="none" />
      <path d="M50 136c11-18 48-24 51-36 4-12-32-7-27-19 3-9 24-10 23-21" stroke="#ddc893" strokeWidth="2" strokeDasharray="3 5" />
      <g stroke="#203e30" strokeLinejoin="round">
        <path d="m109 37-10 18h5L91 74h8l-12 16h43l-13-17h8l-13-18h6Z" fill="#769268" />
        <path d="M108 88v11" stroke="#9c8460" strokeWidth="4" />
        <path d="m135 20-11 21h6l-16 23h9l-13 19h48l-15-21h7l-14-21h6Z" fill="#91a378" />
        <path d="M134 82v12" stroke="#a88d65" strokeWidth="4" />
      </g>
      <path d="m96 102 23-11c7-3 17 12 11 16l-24 12Z" fill="#a37c50" stroke="#503f32" />
      <ellipse cx="101" cy="111" rx="7" ry="10" transform="rotate(-28 101 111)" fill="#ddbd86" stroke="#624d37" />
      <ellipse cx="101" cy="111" rx="3.4" ry="6" transform="rotate(-28 101 111)" stroke="#a17b4f" />
      <path d="m111 103 13-6m-9 13 12-6" stroke="#77583e" />
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

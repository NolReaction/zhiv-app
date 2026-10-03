import type { ReactNode } from "react";

/** Crafted goods share a 48 × 48 viewBox and the item illustration outline. */
export const craftedItemArt: Record<string, ReactNode> = {
  planks: (
    <>
      <path d="m6 14 28-6 8 5-28 7Z" fill="#e3b574" />
      <path d="m14 20 28-7v5l-28 7-8-5v-6Z" fill="#a96c3c" />
      <path d="m6 23 28-6 8 5-28 7Z" fill="#e3b574" />
      <path d="m14 29 28-7v5l-28 7-8-5v-6Z" fill="#a96c3c" />
      <path d="m6 32 28-6 8 5-28 7Z" fill="#e3b574" />
      <path d="m14 38 28-7v5l-28 7-8-5v-6Z" fill="#a96c3c" />
      <path d="m17 14 12-3m-11 13 13-3m-13 13 13-3" fill="none" stroke="#a96c3c" strokeWidth="1.5" />
      <path d="M14 20v5m0 4v5m0 4v5" fill="none" />
    </>
  ),
  rope: (
    <>
      <path d="M32 26c-1 10 1 14 7 12" fill="none" strokeWidth="7" />
      <path d="M32 26c-1 10 1 14 7 12" fill="none" stroke="#d7b574" strokeWidth="4" />
      <path d="M14 32C5 27 6 14 15 9c11-6 23 1 23 12 0 10-8 15-16 13-8-2-13-11-8-17 4-6 13-5 16 1 3 5 0 11-5 10-5 0-7-5-4-8" fill="none" strokeWidth="7" />
      <path d="M14 32C5 27 6 14 15 9c11-6 23 1 23 12 0 10-8 15-16 13-8-2-13-11-8-17 4-6 13-5 16 1 3 5 0 11-5 10-5 0-7-5-4-8" fill="none" stroke="#d7b574" strokeWidth="4" />
      <path d="m11 13 3 2m7-8 1 4m10-1-2 3m8 8-4 1M11 24l3-1m9 9-1 4m12-2-4 1" fill="none" stroke="#9b783f" strokeWidth="1.3" />
      <path d="m38 37 4-3m-3 4 5 1m-6 0 3 4m-28-12-4 3m5-2-1 5" fill="none" stroke="#a98248" strokeWidth="2" />
    </>
  ),
  metal_parts: (
    <>
      <path d="m17 6 7 1 1 5 4 2 5-2 4 6-4 4v4l4 3-3 6-5-1-4 3-1 5-7-1-1-5-4-2-5 2-4-6 4-4v-4l-4-3 3-6 5 1 4-3Z" fill="#93a6a1" />
      <circle cx="21" cy="24" r="7" fill="#e8dec4" />
      <path d="m30 32 9-9 5 5-9 9-4 1Z" fill="#c1cbc2" />
      <path d="m34 21 5-2 5 5-2 5-5 1-5-5Z" fill="#93a6a1" />
      <path d="m37 23 3 3m-8 6 3 3" fill="none" />
      <path d="M13 18c2-4 6-6 10-5" fill="none" stroke="#d9e0d5" strokeWidth="2.5" />
    </>
  ),
  charcoal: (
    <>
      <path d="m8 16 8-9 12 3 6 9-6 12-15 1-8-7Z" fill="#414b48" stroke="#84938a" />
      <path d="m8 16 8-9 12 3-9 8Z" fill="#65756c" stroke="none" />
      <path d="m8 16 11 2 9-8m-9 8-6 14m6-14 9 13" fill="none" stroke="#84938a" />
      <path d="m25 25 10-7 8 9-1 10-11 6-10-8Z" fill="#313a38" stroke="#84938a" />
      <path d="m25 25 9 4 9-2m-9 2-3 14" fill="none" stroke="#84938a" />
      <path d="m6 32 8-5 9 6-3 9-10 1-5-5Z" fill="#414b48" stroke="#84938a" />
      <path d="m9 33 6 2 5-2m-5 2-3 5" fill="none" stroke="#84938a" />
    </>
  ),
  iron_ingot: (
    <>
      <path d="m8 19 25-9 7 7-25 10Z" fill="#c1cbc2" />
      <path d="m8 19-4 12 11 9V27Z" fill="#93a6a1" />
      <path d="m15 27 25-10 4 14-29 9Z" fill="#7c9390" />
      <path d="m14 19 18-6m-11 17 14-5" fill="none" stroke="#e0e6d9" strokeWidth="2.5" />
      <path d="m8 28 4 3" fill="none" stroke="#c1cbc2" />
    </>
  ),
  bricks: (
    <>
      <path d="m5 27 24-8 14 8-24 9Z" fill="#dc9b70" />
      <path d="m5 27 14 9v8L5 36Z" fill="#b66e4e" />
      <path d="m19 36 24-9v8l-24 9Z" fill="#c68158" />
      <path d="m11 14 17-6 12 7-17 7Z" fill="#e6aa7f" />
      <path d="m11 14 12 8v10l-12-7Z" fill="#b66e4e" />
      <path d="m23 22 17-7v10l-17 7Z" fill="#c68158" />
      <path d="m31 32 1 7M12 32v8m6-26 9-3m0 14 8-3" fill="none" stroke="#86523d" strokeWidth="1.5" />
    </>
  ),
  glass: (
    <>
      <path d="m8 11 24-5 5 29-24 6Z" fill="#b6ddd7" />
      <path d="m12 14 17-4 4 22-17 4Z" fill="#dff0df" stroke="#80b6b1" strokeWidth="1.5" />
      <path d="m15 23 10-10m-7 16 11-11" fill="none" stroke="#fff7df" strokeWidth="3" />
      <path d="m28 42 11-20 5 15Z" fill="#c6e7df" />
      <path d="m34 36 5-9" fill="none" stroke="#fff7df" strokeWidth="2" />
    </>
  ),
  cloth: (
    <>
      <path d="M13 8c8 4 17-3 26 1l-3 20c-8-3-16 6-26 2Z" fill="#99b8b4" />
      <path d="M10 13c9 5 18-3 28 0l-5 23c-8-4-16 6-27 1Z" fill="#e9dfc2" />
      <path d="M8 32c10 5 19-5 26-1" fill="none" stroke="#90aaa4" strokeWidth="3" />
      <path d="m17 20-3 10m14-12-3 9" fill="none" stroke="#c1ae87" strokeWidth="1.5" />
      <path d="M12 17c6 2 13-2 19-2" fill="none" stroke="#fff7df" strokeWidth="2" />
      <path d="m10 38-1 4m6-4-1 4m7-6-1 4m7-5-1 4m6-3-1 4" fill="none" stroke="#d1c09b" strokeWidth="2" />
    </>
  ),
  beams: (
    <>
      <path d="m5 30 26-23 10 2-26 24Z" fill="#d3a365" />
      <path d="m15 33 26-24 1 10-26 24Z" fill="#a96c3c" />
      <path d="m5 30 10 3 1 10-10-3Z" fill="#e3b574" />
      <path d="m6 18 25 13 10-4-25-13Z" fill="#e3b574" />
      <path d="m6 18 25 13v10L6 28Z" fill="#a96c3c" />
      <path d="m31 31 10-4v10l-10 4Z" fill="#d3a365" />
      <path d="m11 23 14 7m-10-9 8 4m-7-1 15-13" fill="none" stroke="#795234" strokeWidth="1.5" />
      <path d="m34 33 4-2v4l-4 2Zm-26 2 4 1v3l-4-1Z" fill="none" stroke="#a96c3c" strokeWidth="1.3" />
    </>
  ),
  tools: (
    <>
      <path d="m8 8 6-3 5 10-5 4Z" fill="#93a6a1" />
      <path d="m14 18 5-3 18 23-5 4Z" fill="#c1cbc2" />
      <path d="m16 20 5-4 7 10-5 4Z" fill="#a96c3c" />
      <path d="m10 38 22-24 5 5-22 24c-3 2-7-2-5-5Z" fill="#d3a365" />
      <path d="m25 8 6-3 12 11-5 6-5-4-4 3-5-5 4-4Z" fill="#93a6a1" />
      <path d="m30 8 10 9m-25 20 9-10" fill="none" stroke="#e0e6d9" strokeWidth="2" />
      <path d="m10 9 4 6" fill="none" stroke="#e0e6d9" strokeWidth="1.5" />
    </>
  ),
  reinforced_parts: (
    <>
      <path d="m10 9 25-3 7 6-4 27-24 5-8-8Z" fill="#7c9390" />
      <path d="m10 9 25-3 3 27-24 5Z" fill="#c1cbc2" />
      <path d="m13 15 20-3 1 5-20 4Zm2 13 20-4 1 5-20 4Z" fill="#a98b51" />
      <path d="m15 10 6-1 11 26-6 2Z" fill="#93a6a1" />
      <circle cx="15" cy="16" r="2" fill="#e6d4a5" />
      <circle cx="31" cy="14" r="2" fill="#e6d4a5" />
      <circle cx="18" cy="29" r="2" fill="#e6d4a5" />
      <circle cx="32" cy="27" r="2" fill="#e6d4a5" />
      <path d="m14 38 4 6m20-11 4-21" fill="none" />
    </>
  ),
  cut_stone: (
    <>
      <path d="m5 29 24-9 14 8-23 10Z" fill="#c1cbc2" />
      <path d="m5 29 15 9v6L5 36Z" fill="#93a6a1" />
      <path d="m20 38 23-10v8L20 44Z" fill="#9aac9e" />
      <path d="m8 15 21-8 12 7-21 9Z" fill="#d6ddcd" />
      <path d="m8 15 12 8v12L8 27Z" fill="#93a6a1" />
      <path d="m20 23 21-9v12l-21 9Z" fill="#b0bfb2" />
      <path d="m12 17 5 3m8 7 11-4m-12 8 5-2m2 9 7-3" fill="none" stroke="#e5e8d7" strokeWidth="2" />
      <path d="m31 19-2 3m-13 6 1 4" fill="none" stroke="#718a7e" strokeWidth="1.5" />
    </>
  ),
};

import type { ReactNode } from "react";

/** Prepared meals use different serving shapes so they remain distinct at 24 px. */
export const foodItemArt: Record<string, ReactNode> = {
  grilled_silverfin: <>
    <path d="m5 34 10-6 27 5-8 10-25-2Z" fill="#667767" />
    <path d="m11 35 5 2m9-2 4 3m5-3 3 1" stroke="#de9762" strokeWidth="3" />
    <path d="m13 21-7-6 1 13 7-4c8 7 20 4 27-4-9-7-20-8-28 1Z" fill="#d4c4a0" />
    <path d="M16 23c8 2 15 0 21-3" stroke="#f2e3b5" strokeWidth="3" />
    <path d="m20 16-3 8m10-9-3 9m9-7-3 7" stroke="#976743" />
    <circle cx="36" cy="19" r="1.4" fill="#344236" stroke="none" />
    <path d="M20 10c-4-3 3-4 0-7m10 8c-3-3 3-4 0-7" stroke="#a6b2a0" strokeWidth="1.4" />
  </>,
  smoked_bream: <>
    <path d="m7 13 32-3 4 28-32 7Z" fill="#b98b55" />
    <path d="m12 17 25-3M14 39l23-4" stroke="#e0bd82" />
    <path d="m13 26-6-6 2 12 6-3c5 8 21 8 24-2-4-13-19-14-26-1Z" fill="#c58e4c" />
    <path d="m21 19 6-6 1 9" fill="#a76c3e" />
    <path d="m20 21-2 10m9-12-3 15m10-11-3 9" stroke="#825739" strokeWidth="2.5" />
    <circle cx="35" cy="26" r="1.4" fill="#344236" stroke="none" />
    <path d="M12 10c-3-3 3-4 0-7m12 7c-3-3 3-4 0-7" stroke="#9da994" strokeWidth="1.4" />
  </>,
  mooncarp_blueberries: <>
    <ellipse cx="24" cy="30" rx="21" ry="13" fill="#acb4cb" />
    <ellipse cx="24" cy="29" rx="17" ry="9" fill="#e2dbb7" />
    <path d="m14 23-7-5 2 12 6-3c5 7 17 6 24-2-6-9-18-11-25-2Z" fill="#d6b97e" />
    <path d="m18 23 3 6m3-9 3 9m3-7 3 5" stroke="#a47b4f" />
    <circle cx="34" cy="23" r="1.4" fill="#344236" stroke="none" />
    <circle cx="15" cy="35" r="4" fill="#697da3" /><circle cx="23" cy="36" r="3.5" fill="#526c94" />
    <path d="M28 37c-2-7 4-9 9-7-1 6-5 9-9 7Z" fill="#87a174" />
    <path d="M30 7a7 7 0 1 0 8 9 7 7 0 0 1-8-9Z" fill="#e9d69a" strokeWidth="1.2" />
  </>,
  pike_berry_sauce: <>
    <path d="m5 22 30-12 10 24-30 11Z" fill="#a4b58a" />
    <path d="m13 23-7-4 3 12 5-4 24-1 7-7-10-2Z" fill="#b5a46f" />
    <path d="m16 20 5-8 4 7m1 7 5 5 1-6" fill="#7e9264" />
    <path d="M17 23c9-5 18-3 18 0-4 5-11 4-18 4Z" fill="#b56372" stroke="#8b4d5c" />
    <circle cx="38" cy="20" r="1.2" fill="#344236" stroke="none" />
    <circle cx="23" cy="37" r="4" fill="#b55e71" /><circle cx="30" cy="35" r="3.5" fill="#9f4e65" />
    <path d="m20 36 3-2m4 1 3-2M14 34l3-3" stroke="#edb5a9" />
  </>,
  eel_in_jar: <>
    <path d="M15 12h18v8c6 6 7 11 5 19-4 6-24 6-28 0-2-8-1-13 5-19Z" fill="#b97f56" />
    <ellipse cx="24" cy="12" rx="10" ry="4" fill="#ddba86" />
    <path d="M13 31c6 5 16 5 22 0m-22 7c7 4 15 4 22 0" stroke="#edc78f" strokeWidth="2.5" />
    <path d="M16 23c17-1 20-10 12-15-9-5-14 4-6 9" stroke="#718c78" strokeWidth="6" />
    <path d="M16 23c8 0 15-3 16-7" stroke="#b9c3a0" strokeWidth="2" />
    <circle cx="22" cy="15" r="1.2" fill="#263c32" stroke="none" />
    <path d="m15 10-6-4m26 15 7-5" stroke="#93a07a" strokeWidth="2" />
  </>,
  festive_sturgeon: <>
    <path d="m4 30 20-9 20 9-5 11H9Z" fill="#d6b366" />
    <path d="m9 33 15 6 15-6" stroke="#f5dca1" strokeWidth="3" />
    <path d="m13 23-8-6 2 13 7-4 22 1 9-7-11-2Z" fill="#94a195" />
    <path d="m17 21 4-8 5 7m2 6 6 6 1-6" fill="#6a817b" />
    <path d="m16 24 5-4 5 3 5-3 5 2" stroke="#ead6a2" strokeWidth="2.5" />
    <circle cx="38" cy="21" r="1.2" fill="#344236" stroke="none" />
    <path d="m19 9-2-6 6 3 5-4 1 7Z" fill="#e6be64" />
    <circle cx="13" cy="37" r="3" fill="#a96374" /><circle cx="35" cy="36" r="3" fill="#ae6474" />
  </>,
  berry_compote: <>
    <path d="M11 18h26v19c0 9-26 9-26 0Z" fill="#d6a195" />
    <path d="M15 23h18v13c0 6-18 6-18 0Z" fill="#a55769" strokeWidth="1.3" />
    <ellipse cx="24" cy="18" rx="13" ry="5" fill="#d4b286" />
    <path d="M13 11h22v8H13Z" fill="#b68b55" />
    <ellipse cx="24" cy="11" rx="11" ry="3.5" fill="#e7c38e" />
    <path d="M16 21v13" stroke="#efd3bd" strokeWidth="2.6" />
    <circle cx="22" cy="31" r="3.4" fill="#c87385" strokeWidth="1.2" />
    <circle cx="28" cy="35" r="3.2" fill="#c87385" strokeWidth="1.2" />
    <path d="m20 12 8-1M17 39c4 2 10 2 14 0" stroke="#f2d9af" strokeWidth="1.4" />
  </>,
  grilled_fish: <>
    <ellipse cx="24" cy="31" rx="20" ry="11" fill="#e5dcc0" />
    <ellipse cx="24" cy="30" rx="16" ry="7" fill="#bdc8a0" stroke="#89967a" strokeWidth="1.4" />
    <path d="m15 23-8-6 1 9-1 7 8-5c7 6 19 4 25-5-7-7-18-7-25 0Z" fill="#d6a15c" />
    <path d="M16 27c8 2 15 0 21-4" stroke="#f4d295" strokeWidth="2.5" />
    <path d="m20 19-3 7m10-9-4 10m10-8-4 8" stroke="#87532e" strokeWidth="2.5" />
    <circle cx="35" cy="22" r="1.4" fill="#344236" stroke="none" />
    <path d="M15 36c-5-5-6-3-7-1 0 3 4 4 7 1Zm0 0c-1-6 3-7 5-5 1 3-1 5-5 5Z" fill="#719455" strokeWidth="1.3" />
    <path d="M18 12c-3-3 3-4 0-7m9 6c-3-3 3-4 0-7" stroke="#a6b2a0" strokeWidth="1.6" />
  </>,
  fish_soup: <>
    <path d="m32 20 7-15 4 2-8 16Z" fill="#be9058" />
    <path d="M6 24h36l-5 15c-5 6-21 6-26 0Z" fill="#9d6750" />
    <path d="M10 32c7 6 22 6 28 0l-2 7c-5 4-18 4-23 0Z" fill="#c18a65" stroke="none" />
    <ellipse cx="24" cy="24" rx="18" ry="9" fill="#e3b05f" />
    <ellipse cx="24" cy="24" rx="14.5" ry="6.2" fill="#d3924b" stroke="#eecf8d" strokeWidth="1.5" />
    <path d="m20 22-5-3v8l5-3c4 4 10 3 13-1-4-4-9-5-13-1Z" fill="#f3d6a4" strokeWidth="1.2" />
    <circle cx="29" cy="22" r=".9" fill="#344236" stroke="none" />
    <path d="m11 24 3 1m17 4 3-1m-9-10 3 1" stroke="#789450" strokeWidth="2.5" />
    <path d="M15 11c-3-3 3-4 0-7m9 8c-3-3 3-4 0-7" stroke="#a6b2a0" strokeWidth="1.6" />
    <path d="M17 40c4 1 10 1 14 0" stroke="#ebc592" strokeWidth="1.5" />
  </>,
  berry_fish: <>
    <path d="m8 12 30-3 6 24-31 9-9-5Z" fill="#91a67c" />
    <path d="m8 12 5 24 31-3m-31 3v6" stroke="#647b5d" strokeWidth="1.5" />
    <path d="m14 21-5-5 1 11 5-2c8 6 18 2 23-7-9-5-18-3-24 3Z" fill="#d9a269" />
    <path d="M17 19c4-2 8-3 12-2 4 1 5 4 4 6-4 2-9 4-15 3l-2-3 4-1Z" fill="#a45169" stroke="#744153" strokeWidth="1.2" />
    <path d="m21 19 3 1m2 3 3-1" stroke="#e0a0a5" strokeWidth="1.5" />
    <circle cx="33" cy="18" r="1.3" fill="#344236" stroke="none" />
    <circle cx="24" cy="34" r="4" fill="#a5526c" strokeWidth="1.5" />
    <circle cx="31" cy="33" r="4" fill="#874460" strokeWidth="1.5" />
    <circle cx="28" cy="28" r="3.5" fill="#b6677d" strokeWidth="1.5" />
    <path d="M30 29c-1-7 5-9 9-6-1 5-4 7-9 6Z" fill="#b4bd71" strokeWidth="1.3" />
    <path d="m23 33 1-1m3-5 1-1" stroke="#f0c4bf" strokeWidth="1.5" />
  </>,
  hearty_fish: <>
    <path d="M11 20c-9-7-10 9-1 9m27-9c9-7 10 9 1 9" stroke="#65766e" strokeWidth="3.5" />
    <path d="M9 22h30l-2 16c-4 7-22 7-26 0Z" fill="#708e86" />
    <path d="M14 30v7c4 4 16 4 20 0v-7" stroke="#a7b6a1" strokeWidth="2" />
    <ellipse cx="24" cy="22" rx="15" ry="8" fill="#bd8b51" />
    <path d="m14 19 2-7 7-2 7 4-4 10-8 1Z" fill="#e0b675" />
    <path d="m19 13 6 3-4 6m-7-3 5 2" stroke="#985f3b" strokeWidth="1.7" />
    <path d="m25 21 5-7 7 4-2 7-7 2Z" fill="#c8a77b" />
    <path d="m30 19 4 2m-5 2 4 1" stroke="#ead1a0" strokeWidth="1.6" />
    <path d="M24 25c-6-1-7 3-3 5 4 0 6-2 7-5-1-5-5-6-7-3" fill="#83a568" strokeWidth="1.3" />
    <path d="M15 7c-2-2 2-3 0-5m15 7c-2-2 2-3 0-5" stroke="#a6b2a0" strokeWidth="1.6" />
  </>,
  epic_fish: <>
    <path d="M8 23c-8-5-7 7 0 6m32-6c8-5 7 7 0 6" stroke="#7d6985" strokeWidth="3" />
    <path d="M7 22h34l-4 16c-6 7-20 7-26 0Z" fill="#82718f" />
    <path d="M12 34c6 4 18 4 24 0" stroke="#cdb5cb" strokeWidth="2" />
    <ellipse cx="24" cy="22" rx="17" ry="9" fill="#dfb66f" />
    <path d="m13 19 5-8 12 3-3 11-10 3Z" fill="#f0d7a2" />
    <path d="m20 14 5 3m-8 1 7 3m-8 1 7 3" stroke="#b2824a" strokeWidth="1.7" />
    <path d="m27 23 5-6 7 3-3 8-9 1Z" fill="#d69f67" />
    <path d="m28 25 6-2m-17 5 3 1" stroke="#8c633b" strokeWidth="1.5" />
    <path d="M10 22c-1-7 5-8 7-3-1 4-4 5-7 3m23-8c1-6 6-7 8-3-2 4-5 5-8 3" fill="#8aa165" strokeWidth="1.3" />
    <path d="M16 7c-3-3 3-4 0-6m13 8c-3-3 3-4 0-6" stroke="#a6b2a0" strokeWidth="1.6" />
  </>,
  legendary_fish: <>
    <ellipse cx="24" cy="33" rx="21" ry="11" fill="#c39743" />
    <ellipse cx="24" cy="31" rx="18" ry="8" fill="#f0d38a" stroke="#8b783f" strokeWidth="1.5" />
    <path d="m13 23-7-5 2 10-2 7 8-5c7 6 20 3 27-5-9-8-21-10-28-2Z" fill="#83948c" />
    <path d="m22 21 7-12 1 13" fill="#637e7b" />
    <path d="M16 27c8 3 16 0 21-2" stroke="#e6c58e" strokeWidth="3" />
    <path d="m18 22 3 7m3-8 3 7m3-7 3 6" stroke="#715639" strokeWidth="2" />
    <circle cx="36" cy="24" r="1.3" fill="#344236" stroke="none" />
    <path d="M14 37c0-7 6-8 8-3-2 5-5 6-8 3m14 1c-1-6 5-8 8-4-1 4-5 6-8 4" fill="#88a467" strokeWidth="1.4" />
    <path d="m9 7 1-4 2 4 4 2-4 1-2 4-1-4-4-1Zm29 4 1-3 1 3 3 1-3 1-1 3-1-3-3-1Z" fill="#efd991" stroke="#ab8845" strokeWidth="1.1" />
  </>,
};

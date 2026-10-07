import type { ReactNode } from "react";

/** Prepared meals use different serving shapes so they remain distinct at 24 px. */
export const foodItemArt: Record<string, ReactNode> = {
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
};

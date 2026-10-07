import type { ReactNode } from "react";

/** Native 48 × 48 masters; the glow belongs to the UI, so icons stay legible at recipe size. */
export const relicItemArt: Record<string, ReactNode> = {
  ancient_core: <>
    <path d="m11 8 17-3 12 9 3 17-9 12-19-1L5 30l1-13Z" fill="#7a8979" />
    <path d="m11 8 17-3 12 9-8 5-14-2-12 0Z" fill="#b1b79a" />
    <path d="m5 30 13 3 15-2 10 0-9 12-19-1Z" fill="#546c60" stroke="none" />
    <path d="M24 13c9 0 14 6 12 15-1 7-8 12-15 10-8-2-12-8-10-15 2-6 6-10 13-10Z" fill="#b29f62" />
    <path d="M24 17c7 0 10 4 9 10-1 5-5 8-10 8-6-1-10-5-8-10 1-5 4-8 9-8Z" fill="#d7c587" />
    <path d="m21 22 5-3 3 5-3 5-5-1-2-4Zm5 7-2 5m-5-10-4 1m11-6 1-5" stroke="#796c41" strokeWidth="1.5" />
    <path d="m10 18 3-3m21 21 3-4" stroke="#c7d6a9" strokeWidth="2" />
  </>,
  moon_crystal: <>
    <path d="m16 7 13-3 12 12-2 18-16 11L8 30l1-13Z" fill="#a5afc8" />
    <path d="m16 7 8 12 5-15 12 12-17 3-15-2Z" fill="#d6d9e4" />
    <path d="m9 17 15 2-1 26L8 30Z" fill="#8f91b4" />
    <path d="m24 19 17-3-2 18-16 11Z" fill="#b5b7d0" />
    <path d="m16 7 8 12m5-15-5 15m-15-2 15 2 17-3m-17 3-1 26m-15-15 15-4 16 8" stroke="#6d779b" strokeWidth="1.3" />
    <path d="M29 14c-5 1-8 7-5 12 2 3 6 5 10 2-4 0-7-3-7-7 0-3 1-5 2-7Z" fill="#f4efce" stroke="#e0dcc6" strokeWidth="1" />
    <path d="m13 15 3-5m1 22 3 4" stroke="#e2e4eb" strokeWidth="2.2" />
  </>,
  living_resin: <>
    <path d="M24 5C18 15 7 23 7 33c0 7 7 11 17 11s17-4 17-11c0-10-11-18-17-28Z" fill="#bfaa56" />
    <path d="M26 10c5 13 9 22 6 29 7-1 9-4 9-8-1-8-9-15-15-21Z" fill="#9b9951" stroke="none" />
    <path d="M24 17c-8 1-13 6-12 13 1 6 7 9 14 6 6-3 9-9 6-15-2-3-5-4-8-4Z" fill="#d8c677" stroke="#aa9d55" strokeWidth="1.2" />
    <path d="M19 33c-5-8 0-14 12-14 0 9-3 15-12 14Z" fill="#78a471" />
    <path d="m17 36 11-14m-7 9 6-1m-3-4v-4" stroke="#486f4d" strokeWidth="1.5" />
    <path d="M14 24c-2 3-3 6-2 8" stroke="#fae9ac" strokeWidth="3" />
    <circle cx="34" cy="32" r="2" fill="#ead894" stroke="none" />
  </>,
};

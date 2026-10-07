import type { ReactNode } from "react";
import { mossPalette } from "@/features/mochlik/appearance-palette";

function mossTuft(base: string, light: string, dark: string, outline: string) {
  return (
    <>
      <path d={outline} fill={base} />
      <path d="M7 30c5 7 9 3 14 5 7 3 11-4 20-6l-2 7-8 4-10-1-10 1-5-5Z" fill={dark} stroke="none" />
      <path d="m11 25 3-6 4 5m4-4 3-7 3 7m4 5 4-5 2 5m-19 8 4-5 3 4" fill="none" stroke={light} strokeWidth="3" />
    </>
  );
}

function scarf(base: string, light: string, dark: string) {
  return (
    <>
      <path d="m14 18-5 19 10 3 7-18Z" fill={base} />
      <path d="m26 18-3 22 11 2 3-24Z" fill={base} />
      <path d="m10 37-1 4m5-3-1 4m5-2-1 3m6-3-1 3m6-2v3m5-2v2" fill="none" />
      <path d="M10 13c0-5 7-8 15-8s14 3 14 8v7c-2 5-9 7-16 6-8-1-13-4-13-8Z" fill={base} />
      <ellipse cx="25" cy="12" rx="10" ry="4" fill={dark} />
      <path d="M10 14c5 6 18 7 29 0" fill="none" />
      <path d="m14 29 5 2m7 3 6 1m-15-14 8 2" fill="none" stroke={light} />
      <path d="m27 17 8 3-3 9-9-4Z" fill={light} />
      <path d="m28 21 3 1" fill="none" stroke={base} />
    </>
  );
}

function mossShade(id: string) {
  const { moss, mossLight, mossDark } = mossPalette(id);
  return mossTuft(moss, mossLight, mossDark,
    "M6 29c-3-5 1-9 6-8-3-7 1-12 7-9 1-8 9-9 12-2 6-4 11 2 8 8 6 2 7 9 2 13l-2 5-8 4-10-1-10 1-5-5Z");
}

/** Wardrobe pieces, with moss colours matching the equipped character. */
export const equipmentArt: Record<string, ReactNode> = {
  moss: mossTuft(
    "#7c8845", "#a5ad58", "#58683b",
    "M6 29c-3-5 1-9 6-8-3-7 1-12 7-9 1-8 9-9 12-2 6-4 11 2 8 8 6 2 7 9 2 13l-2 5-8 4-10-1-10 1-5-5Z",
  ),
  fern: mossTuft(
    "#49816b", "#7fb99a", "#345649",
    "M6 29 5 22l7 1-3-9 9 3 1-11 7 7 7-7 1 12 8-3-3 10 4 1-4 10-8 4-10-1-10 1-5-5Z",
  ),
  autumn: mossTuft(
    "#b27b42", "#d8ae63", "#7a5637",
    "M6 29 5 20l8 1-1-9 8 4 5-11 5 11 7-5 1 11 6-1-3 10-2 5-8 4-10-1-10 1-5-5Z",
  ),
  amber_scarf: scarf("#e2a44d", "#f1cb79", "#a7723e"),
  berry_scarf: scarf("#b96374", "#e4a1a5", "#88485e"),
  heather: mossShade("heather"),
  frost: mossShade("frost"),
  ember: mossShade("ember"),
  river_scarf: scarf("#6299b1", "#c1e0dd", "#426d85"),
  moon_scarf: <>
    {scarf("#b7afd7", "#ddd4ee", "#7b739b")}
    <path d="m16 29 1-3 2 3 3 1-3 1-2 3-1-3-3-1Z" fill="#f2e5ba" stroke="none" />
  </>,
  forest_bandana: <>
    <path d="M7 15c9-8 24-8 34 0l-16 26Z" fill="#77905f" />
    <path d="M7 15c8 2 26 2 34 0l-4 8c-7 2-17 2-25 0Z" fill="#aaba80" />
    <path d="m11 18 13 18 13-18" fill="none" stroke="#c9d6aa" strokeWidth="1.5" />
    <path d="m7 15-4 9 8-3m30-6 4 9-8-3" fill="#77905f" />
    <path d="M22 24c4-5 7-3 6 0-1 3-3 4-5 4m-3 3 7-10" fill="#c9d6aa" strokeWidth="1" />
  </>,
  acorn_cap: <>
    <path d="M22 9c-2-5 0-7 4-7l2 2c-3 0-3 2-2 5Z" fill="#795336" />
    <path d="M8 29C8 16 14 8 24 8s16 8 16 21Z" fill="#996743" />
    <path d="M13 23c2-7 5-10 10-11" fill="none" stroke="#bb8652" strokeWidth="3" />
    <path d="M5 28c9-4 29-4 38 0v7c-8 7-30 7-38 0Z" fill="#c5955e" />
    <path d="m8 29 6 5 6-5 6 5 6-5 7 5m-28 3 3-3 6 5 6-5 6 4" fill="none" stroke="#795336" strokeWidth="1.5" />
    <path d="M7 29c10-3 25-3 34 0" fill="none" stroke="#e0b984" strokeWidth="1.5" />
  </>,
  knitted_cap: <>
    <path d="M9 32 12 18c2-7 6-10 12-10s11 3 13 10l3 14Z" fill="#697caa" />
    <path d="M17 15 14 29m9-16-1 16m8-14 3 14" fill="none" stroke="#a6b4d1" strokeWidth="2.5" />
    <path d="M21 8c-5-4-1-9 3-6 4-3 8 2 4 6-2 2-5 2-7 0Z" fill="#c6ccdf" />
    <path d="M7 30c9-3 25-3 34 0v9c-9 4-25 4-34 0Z" fill="#697caa" />
    <path d="M9 31c8-2 23-2 30 0m-26 4v4m6-5v6m6-6v6m6-6v6m6-5v4" fill="none" stroke="#a6b4d1" strokeWidth="1.7" />
  </>,
  moon_crown: <>
    <path d="M6 27c8 9 27 9 36 0l-2 7c-9 8-23 8-32 0Z" fill="#c3c1e4" />
    <path d="M8 28c8 7 23 7 32 0" fill="none" stroke="#f1ebf8" />
    <path d="M10 27c-6-2-7-8-5-12 6 1 9 7 5 12m5 3c-4-4-3-9 0-12 5 3 6 9 0 12m18 0c4-4 3-9 0-12-5 3-6 9 0 12m5-3c6-2 7-8 5-12-6 1-9 7-5 12" fill="#c3c1e4" />
    <path d="M27 7c-7-2-13 6-8 13 3 4 9 4 12 0-8 3-12-9-4-13Z" fill="#eee0ad" />
    <path d="m24 26 2-3 2 3-2 3Z" fill="#f1ebf8" strokeWidth="1" />
  </>,
  leaf_cap: (
    <>
      <path d="M6 28c7-6 24-7 36-1 3 3 1 7-4 8-4 2-6-1-9 0-7 4-19 4-24-1-2-2-1-4 1-6Z" fill="#78934e" />
      <path d="M11 28C10 15 22 8 36 8c-6 4-2 15 3 20-8 5-19 6-28 0Z" fill="#9cb764" />
      <path d="M15 26c1-7 6-11 12-14" fill="none" stroke="#c7d894" />
      <path d="m22 16 7 4m-11 0 8 5M10 31c7 2 12 2 17 0" fill="none" />
      <path d="m35 8 5-3" fill="none" stroke="#78934e" strokeWidth="3" />
    </>
  ),
  explorer_cap: (
    <>
      <path d="M5 29c5-4 11-5 19-5s15 1 19 5c3 7-7 12-19 12S2 36 5 29Z" fill="#c29a61" />
      <path d="M7 30c9 4 24 4 34 0" fill="none" stroke="#edca89" />
      <path d="m12 29 3-17c1-5 7-5 9-2 3-3 10-3 11 2l3 17c-7 5-19 5-26 0Z" fill="#dfbb7f" />
      <path d="m13 23-1 6c7 5 19 5 26 0l-1-6c-7 4-17 4-24 0Z" fill="#996c43" />
      <path d="M20 13c1-2 7-2 9 0" fill="none" stroke="#c29a61" />
      <path d="M31 24c-2-7 3-12 10-12 1 7-3 12-10 12Z" fill="#82a653" />
      <path d="m30 28 7-10" fill="none" />
    </>
  ),
  willow_rod: (
    <>
      <path d="M31 6c10 0 12 8 11 17l-3 9" fill="none" stroke="#8a947c" />
      <path d="M7 39C12 22 17 9 32 5c-13 8-16 20-21 36Z" fill="#aa8651" />
      <path d="m6 35 7 2-2 7-7-2Z" fill="#745b3d" />
      <path d="m7 38 4 1m4-11 2 1m2-10 2 1" fill="none" stroke="#dfbd7e" />
      <path d="m38 28-2 5 6 2 1-4Z" fill="#bb6470" />
      <path d="m36 33-1 5 4 3 3-6Z" fill="#f0dfb9" />
      <path d="m38 40-1 4" fill="none" />
    </>
  ),
};

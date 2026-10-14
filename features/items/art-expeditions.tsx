import type { ReactNode } from "react";

/** Expedition provisions use the same 48 × 48 illustration frame as other goods. */
export const expeditionItemArt: Record<string, ReactNode> = {
  trail_ration: <>
    <path d="m7 18 29-4 6 21-28 8-9-7Z" fill="#bca474" />
    <path d="m7 18 7 17 28 0M14 35v8" stroke="#806849" strokeWidth="1.5" />
    <path d="m12 15 13-3 5 6-14 5Z" fill="#e3c48c" />
    <path d="m14 19 8-2m-7 5 10-3" stroke="#9d7750" strokeWidth="1.3" />
    <path d="m20 27-7-5 1 7-1 5 7-3c5 4 13 2 18-4-6-5-13-5-18 0Z" fill="#cf9862" />
    <path d="m23 25-2 6m8-8-3 7" stroke="#835a3b" strokeWidth="1.7" />
    <circle cx="34" cy="27" r="1.1" fill="#344236" stroke="none" />
    <circle cx="30" cy="10" r="4" fill="#a65773" strokeWidth="1.3" />
    <path d="m28 6 4-2 3 3" stroke="#73895d" strokeWidth="1.5" />
    <path d="m10 13 3-5 4 5" fill="#e4d5ad" strokeWidth="1.5" />
  </>,
  research_gear: <>
    <path d="M15 13c0-10 18-10 18 0" stroke="#8c7251" strokeWidth="4" />
    <path d="M12 12h25l5 25-7 7H13l-6-8Z" fill="#819986" />
    <path d="M12 12h25l-2 14H14Z" fill="#bca474" />
    <path d="M10 30h27v10H10Z" fill="#a5b5a0" />
    <path d="M17 15v21m14-21v21" stroke="#6c7760" strokeWidth="3" />
    <path d="M20 22h8v8h-8Z" fill="#d7bd7e" strokeWidth="1.5" />
    <path d="m5 16 5-3 10 19-5 3Z" fill="#c49b62" />
    <path d="m3 10 6-4 8 7-4 6-5-3-3 2Z" fill="#a7b9b2" />
    <path d="m34 11 5-5 5 5-8 9" fill="#d8dfd0" strokeWidth="1.7" />
    <path d="m37 29 5-1 2 10-6 2Z" fill="#d5bc80" />
    <path d="m38 32 5-1m-4 5 5-1" stroke="#99834f" strokeWidth="1.2" />
  </>,
};

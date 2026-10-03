import type { ReactNode } from "react";

/** Natural materials and food, drawn on the shared 48 × 48 item canvas. */
export const naturalItemArt: Record<string, ReactNode> = {
  berries: (
    <>
      <path d="M24 21c-1-7 2-12 6-16" fill="none" />
      <path d="M26 13C17 15 12 10 12 5c8-1 14 1 14 8Z" fill="#82a653" />
      <path d="M27 15c0-7 7-10 14-8-1 7-6 11-14 8Z" fill="#a6bd6d" />
      <path d="m17 20 8-6 8 8M24 16v15" fill="none" />
      <circle cx="15" cy="24" r="8" fill="#af526c" />
      <circle cx="31" cy="24" r="8" fill="#a24966" />
      <circle cx="18" cy="36" r="8" fill="#90465e" />
      <circle cx="32" cy="36" r="8" fill="#af526c" />
      <circle cx="24" cy="29" r="8" fill="#ba6680" />
      <path d="m12 21 2-1m14 2 2-1m-10 6 2-1m8 7 2-1" stroke="#efd0c8" />
    </>
  ),
  wood: (
    <>
      <path d="M10 24 33 13c4-2 10 3 10 8 0 3-1 6-4 7L16 40Z" fill="#a96c3c" />
      <ellipse cx="12" cy="32" rx="8" ry="9" fill="#e3b574" />
      <path d="M11 28c-4 0-4 7 1 7 3 0 3-4 0-4" fill="none" />
      <path d="m23 28 13-6m-13 12 11-5" fill="none" stroke="#744b32" />
      <path d="M11 10 33 20c5 2 4 15-2 15L9 25Z" fill="#b87b46" />
      <path d="m15 13 15 7m-14 1 11 5" fill="none" stroke="#e3b574" />
      <ellipse cx="10" cy="17" rx="6" ry="8" fill="#e3b574" />
      <path d="M10 13c-3 0-3 8 0 8 2 0 2-4 0-4" fill="none" />
    </>
  ),
  stone: (
    <>
      <path d="m7 17 13-9 14 3 9 14-6 12-22 4L5 30Z" fill="#93a6a1" />
      <path d="m7 17 13-9 14 3-4 14-15 1Z" fill="#c1cbc2" />
      <path d="m15 26 15-1 13 0-6 12-22 4Z" fill="#82958f" />
      <path d="m15 26 0 15m15-16 7 12" fill="none" />
      <path d="m12 18 8-5 7 1" fill="none" stroke="#e3e7d8" />
    </>
  ),
  ore: (
    <>
      <path d="m5 27 6-14 15-6 13 8 4 19-16 8-17-5Z" fill="#82958f" />
      <path d="m11 13 15-6 13 8-15 8Z" fill="#bac5bd" />
      <path d="m5 27 19-4 3 19-17-5Z" fill="#93a6a1" />
      <path d="m18 16 9 1 5 7-6 8-8-5Z" fill="#cf8956" />
      <path d="m28 32 6-6 7 5-4 6-8 1Z" fill="#cf8956" />
      <path d="m10 27 7 3-1 7-6-1Z" fill="#cf8956" />
      <path d="m23 20 4 3m5 11 2-2" stroke="#f0c68a" />
    </>
  ),
  fiber: (
    <>
      <path d="M18 28C8 21 9 11 6 7c8 3 11 12 15 19L16 5c8 5 8 16 9 21L31 5c4 9-1 18-2 22L42 10c0 9-5 17-12 20l8 10c-9 0-11-7-14-8-3 6-7 9-14 10Z" fill="#c5ba78" />
      <path d="M19 28 11 15m12 12-4-15m7 16 4-15m-2 17 9-12M20 33l-5 5m12-5 5 5" fill="none" stroke="#827748" />
      <path d="m17 26 14 1-1 7-14-1Z" fill="#a96c3c" />
      <path d="m18 29 11 1" stroke="#e3b574" />
    </>
  ),
  fish: (
    <>
      <path d="m24 15 6-9 6 12m-14 13 8 9 3-10" fill="#82a653" />
      <path d="m16 21-11-8 2 12-2 11 11-8c6 9 22 8 27-3-5-11-21-13-27-4Z" fill="#93b7af" />
      <path d="M16 25c8 4 15 6 25 1-5 8-19 11-25 2" fill="#d0dbba" stroke="none" />
      <path d="M34 17c-4 4-4 12 0 16m-12-7 6-3-1 6Z" fill="#82a653" />
      <circle cx="37" cy="23" r="1.6" fill="#344236" stroke="none" />
      <path d="m8 18 7 7-7 7" fill="none" />
    </>
  ),
  dried_berries: (
    <>
      <path d="M10 17c0-6 25-6 25 0l-3 7c7 7 8 16 2 18H11c-7-2-5-12 1-18Z" fill="#c79e65" />
      <ellipse cx="22.5" cy="17" rx="12.5" ry="5" fill="#866947" />
      <path d="M13 18c-3-7 5-10 8-5 0-9 12-10 13-2 7-1 8 7 1 9" fill="#80445c" />
      <path d="m17 14 2 3m8-6-1 4m8 0-2 3" fill="none" stroke="#bd7787" />
      <path d="M11 20c7 4 15 4 23 0l-2 7H12Z" fill="#e3b574" />
      <path d="m13 29-2 5m19-5 3 7" fill="none" stroke="#866947" />
      <path d="M19 34c-3-5 4-9 7-5 5 0 5 8 0 8-3 4-8 1-7-3Z" fill="#80445c" />
      <path d="m23 30-1 4 3 1" fill="none" stroke="#bd7787" />
    </>
  ),
  smoked_fish: (
    <>
      <path d="m24 15 6-8 6 11m-13 13 6 8 5-10" fill="#9c643b" />
      <path d="m16 20-11-7 2 12-2 11 11-8c8 9 21 7 27-4-6-11-19-12-27-4Z" fill="#bc7e44" />
      <path d="M17 28c8 4 18 1 24-3-5 10-19 10-25 3" fill="#e3b574" stroke="none" />
      <path d="m21 18-4 8m12-10-5 13m11-12-5 12" stroke="#f1cf90" />
      <path d="M35 17c-3 4-3 10 0 15m-26-14 6 6-6 7" fill="none" />
      <circle cx="37" cy="22" r="1.6" fill="#344236" stroke="none" />
    </>
  ),
  clay: (
    <>
      <path d="M5 33c-1-6 2-10 7-13 0-8 8-13 16-10 7-1 12 5 11 12 6 5 6 12 1 16-8 6-28 6-35-5Z" fill="#b77958" />
      <path d="M12 20c1-8 8-12 16-10 7 0 10 4 10 10-6-3-10-1-14 3-5-4-8-4-12-3Z" fill="#dba280" stroke="none" />
      <path d="M12 20c5-2 8-1 12 3 4-4 8-6 15-1M9 30c5 1 8 4 11 7m13-8c-4 0-7 2-8 5" fill="none" />
      <path d="M17 16c2-2 5-3 8-2" fill="none" stroke="#edc5a0" />
    </>
  ),
  sand: (
    <>
      <path d="M5 34c5-3 8-4 10-10 2-7 8-12 12-10 5 2 5 10 10 15l6 5c-4 9-32 10-38 0Z" fill="#d6b66d" />
      <path d="M15 24c2-7 8-12 12-10 2 1 3 3 4 6-5-2-6 6-13 8l-9 6c0-4 4-6 6-10Z" fill="#f1d69b" stroke="none" />
      <path d="M11 35c9 3 19 2 26-1" fill="none" stroke="#a9864c" />
      <path d="m23 26 1 0m6 4 1 0m-13 2 1 0m13-9 1 1" stroke="#a9864c" />
    </>
  ),
  hardwood: (
    <>
      <path d="m12 19 4-8 6-2 3 4-4 7 13-5c4 0 9 6 9 13 0 5-3 9-7 10l-24 5Z" fill="#76503c" />
      <path d="m17 13 5-4 3 4-5 3Z" fill="#c29160" />
      <path d="M14 23 36 17m-16 9 19-5m-17 10 18-5m-17 9 13-3" fill="none" stroke="#a37448" />
      <path d="m31 20-3 5 2 5-3 6" fill="none" />
      <ellipse cx="13" cy="31" rx="9" ry="12" fill="#c29160" />
      <ellipse cx="13" cy="31" rx="5" ry="7" fill="#e3b574" />
      <path d="M13 28c-3 0-3 6 0 6 2 0 2-3 0-3m-1-11 1 4m-1 14 1 4" fill="none" />
    </>
  ),
  resin: (
    <>
      <path d="M27 5c0 10-9 13-9 22 0 7 5 12 12 12s12-5 12-12c0-9-10-12-15-22Z" fill="#dca34e" />
      <path d="M29 15c-2 4-7 7-7 12 0 5 3 8 8 8 2 0 4-1 5-2-8 0-11-7-6-18Z" fill="#f4cf79" stroke="none" />
      <path d="m31 24 4 4-4 4-4-4Z" fill="#b9713b" />
      <path d="M12 26c-2 6-7 8-7 12 0 4 3 6 7 6s7-2 7-6c0-4-5-6-7-12Z" fill="#e8b25d" />
      <path d="M9 37v2m26-19 2 3" fill="none" stroke="#ffdfa0" />
    </>
  ),
};

import type { ReactNode } from "react";

/** Each harvest and dish keeps its own silhouette on the shared 48 × 48 canvas. */
export const berryTierArt: Record<string, ReactNode> = {
  blueberries: <>
    <path d="m22 21 3-13m-1 7c-8 0-12-5-11-10 8 0 12 4 11 10Zm1-3c2-7 8-10 14-6-3 6-8 8-14 6Z" fill="#8ba67b" />
    <circle cx="15" cy="28" r="10" fill="#657ba4" />
    <circle cx="33" cy="28" r="10" fill="#52658e" />
    <circle cx="24" cy="37" r="9" fill="#7184ac" />
    <path d="m13 24 2 2 3-2-1 4-4 1Zm18-1 2 2 3-1-1 4-4-1Zm-9 11 2 2 3-1-1 4-4-1Z" fill="#3f4e71" strokeWidth="1.1" />
    <path d="m10 26 2-2m17 3 2-2m-11 10 2-2" stroke="#b3c5db" strokeWidth="1.8" />
  </>,
  currants: <>
    <path d="M25 5c-3 8-6 17-5 31m4-23 8 9m-9-3-9 7m7 0 9 7" stroke="#777653" />
    <path d="M24 12c-8 1-14-3-14-9 8-1 13 3 14 9Zm1 0c3-7 10-9 16-4-4 6-9 7-16 4Z" fill="#88a56d" />
    <circle cx="31" cy="21" r="5.6" fill="#bb5262" />
    <circle cx="13" cy="27" r="5.7" fill="#cf6570" />
    <circle cx="23" cy="29" r="5.7" fill="#b54559" />
    <circle cx="32" cy="34" r="5.8" fill="#d7797b" />
    <circle cx="18" cy="40" r="5.7" fill="#bf5267" />
    <path d="m29 19 1-1m-19 13 1-1m9-4 1-1m8 6 1-1m-17 7 1-1" stroke="#f1b7ae" strokeWidth="1.8" />
  </>,
  blackberries: <>
    <path d="M23 15c0-7 2-10 6-13" stroke="#698356" />
    <path d="m24 14-10-7-4 6 12 7 14-5-3-7Z" fill="#88a66d" />
    <path d="M16 15c-8 0-13 8-11 15 1 8 7 13 15 12 10 4 21-3 22-13 2-9-5-16-13-15-5-4-10-3-13 1Z" fill="#655173" />
    <circle cx="15" cy="22" r="5.2" fill="#887097" strokeWidth="1.1" />
    <circle cx="25" cy="20" r="5.2" fill="#766385" strokeWidth="1.1" />
    <circle cx="34" cy="25" r="5.2" fill="#584562" strokeWidth="1.1" />
    <circle cx="13" cy="31" r="5.2" fill="#6d567c" strokeWidth="1.1" />
    <circle cx="24" cy="29" r="5.3" fill="#937ba0" strokeWidth="1.1" />
    <circle cx="32" cy="35" r="5.1" fill="#70547e" strokeWidth="1.1" />
    <circle cx="22" cy="38" r="5.1" fill="#594467" strokeWidth="1.1" />
    <path d="m13 21 2-1m8 6 2-1m-14 5 2-1" stroke="#c6b6cf" strokeWidth="1.5" />
  </>,
  cranberries: <>
    <path d="M24 25c-2-11 1-17 8-21" stroke="#7f7054" />
    <path d="M27 12c-8 0-13-5-12-10 7 0 11 3 12 10Zm0 4c5-6 12-6 16-1-5 5-11 5-16 1Z" fill="#91a174" />
    <ellipse cx="13" cy="29" rx="8.2" ry="10.5" transform="rotate(-25 13 29)" fill="#b64456" />
    <ellipse cx="32" cy="30" rx="9.2" ry="11" transform="rotate(22 32 30)" fill="#c75b61" />
    <ellipse cx="23" cy="37" rx="8.6" ry="9" fill="#a43850" />
    <path d="m10 25 1-2m17 4 2-2m-9 11 1-2" stroke="#edaaa0" strokeWidth="2.3" />
    <path d="m8 20 3 1m24 0-3 2m-8 6-2 2" stroke="#806343" strokeWidth="1.4" />
  </>,
  strawberry_compote: <>
    <path d="M18 10h12v9c7 4 8 10 8 20-5 6-24 6-29 0 0-10 2-16 9-20Z" fill="#dfb6a2" />
    <path d="M14 25h20v13c-4 5-16 5-20 0Z" fill="#c86671" strokeWidth="1.3" />
    <path d="M17 7h14v7H17Z" fill="#b58e5d" />
    <ellipse cx="24" cy="7" rx="7" ry="2.5" fill="#e5c58e" strokeWidth="1.4" />
    <path d="M15 24v10" stroke="#f4ddc7" strokeWidth="2.4" />
    <path d="M20 31c0-4 8-5 9-1 0 4-3 7-5 8-2-1-5-4-4-7Z" fill="#e38b85" strokeWidth="1.2" />
    <path d="m24 27-2 3-3-1 2 3 5-1 3-3-4 1Z" fill="#93ad6f" strokeWidth="1" />
    <path d="m23 33 1 1m2-3-1 1" stroke="#f4d7a5" strokeWidth="1.2" />
  </>,
  blueberry_compote: <>
    <path d="M33 19c12-1 12 17 1 17" fill="#c1c4b4" strokeWidth="3" />
    <path d="M8 17h28l-2 21c-4 8-20 8-24 0Z" fill="#bec7bd" />
    <ellipse cx="22" cy="17" rx="14" ry="6" fill="#687ba1" />
    <ellipse cx="22" cy="17" rx="10.5" ry="3.5" fill="#a3a7c9" strokeWidth="1.2" />
    <circle cx="18" cy="17" r="2.6" fill="#52668c" strokeWidth="1" />
    <circle cx="25" cy="16" r="2.8" fill="#6e6890" strokeWidth="1" />
    <path d="M13 23v10m3 5c4 2 9 2 13 0" stroke="#e4e5cc" strokeWidth="2" />
    <path d="m16 5 1 4m9-6-1 5" stroke="#a6b2a0" strokeWidth="1.4" />
  </>,
  currant_jelly: <>
    <ellipse cx="24" cy="37" rx="20" ry="7" fill="#d4c9a3" />
    <path d="M12 20c0-5 24-5 24 0l4 15c-2 8-30 8-32 0Z" fill="#c35b69" />
    <ellipse cx="24" cy="20" rx="12" ry="5" fill="#e7968e" />
    <path d="m14 23-2 11m8-10-1 12m9-12 1 12m5-13 3 11" stroke="#a94558" strokeWidth="1.8" />
    <path d="m15 23-1 7m5 7c5 2 9 1 13 0" stroke="#f3b9a0" strokeWidth="1.8" />
    <circle cx="20" cy="14" r="3.6" fill="#bc465c" strokeWidth="1.2" />
    <circle cx="28" cy="14" r="3.6" fill="#d0616a" strokeWidth="1.2" />
    <path d="m21 11 5-5m-2 1c-4-3-7-1-8 2 4 2 6 1 8-2Z" fill="#95a976" strokeWidth="1.2" />
  </>,
  blackberry_preserve: <>
    <path d="M11 13h26v26c-2 7-24 7-26 0Z" fill="#a793ab" />
    <path d="M14 20h20v19c-4 4-16 4-20 0Z" fill="#665073" strokeWidth="1.2" />
    <path d="M9 9h30v8H9Z" fill="#b5ad83" />
    <path d="m11 9 2-4h22l2 4" fill="#dad1a3" />
    <path d="m14 11 1 4m6-4 1 4m6-4 1 4m5-4 1 4" stroke="#8b8662" strokeWidth="1.2" />
    <path d="M14 26h20v10H14Z" fill="#e1ceab" strokeWidth="1.3" />
    <circle cx="21" cy="30" r="2.2" fill="#715779" strokeWidth=".8" />
    <circle cx="26" cy="30" r="2.2" fill="#8a6b91" strokeWidth=".8" />
    <circle cx="24" cy="34" r="2.1" fill="#594565" strokeWidth=".8" />
    <path d="m24 27 2-3m-10-5v3" stroke="#9cab78" strokeWidth="1.5" />
  </>,
  cranberry_glaze: <>
    <ellipse cx="24" cy="42" rx="13" ry="3.5" fill="#d7c59c" />
    <path d="M21 29h6v12h-6Z" fill="#b7a586" />
    <path d="M6 22h36l-7 10c-5 6-17 6-22 0Z" fill="#e6d6b4" />
    <ellipse cx="24" cy="22" rx="18" ry="6" fill="#bf626b" />
    <path d="M10 21c0-5 5-8 9-7-2-5 2-11 7-9 2 6 12 6 9 12 5 0 6 4 3 6-8 4-20 4-28-2Z" fill="#c95467" />
    <path d="M17 20c9 2 16-1 12-5-3-2-9 0-5 3m-2-9 4 2" stroke="#efb09b" strokeWidth="2" />
    <ellipse cx="34" cy="13" rx="3.7" ry="4.4" fill="#a43e54" strokeWidth="1.2" />
    <path d="m32 10 1-1m-17 20c4 2 13 2 17 0" stroke="#f3d4a6" strokeWidth="1.4" />
    <path d="M29 8c2-5 7-6 11-3-3 4-6 5-11 3Z" fill="#97a67c" strokeWidth="1.2" />
  </>,
};

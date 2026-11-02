import type { ReactNode } from "react";

/** Six kitchen finds with distinct silhouettes in the shared illustrated item set. */
export const cookingDiscoveryArt: Record<string, ReactNode> = {
  berry_tea: <>
    <ellipse cx="24" cy="39" rx="19" ry="5" fill="#adb78b" />
    <path d="M34 20c14-6 14 13 0 12M9 17h27v15c-2 10-24 10-27 0Z" fill="#e1c99a" />
    <ellipse cx="22.5" cy="17" rx="13.5" ry="5" fill="#b96c68" />
    <path d="M14 23v8c0 3 3 5 5 5m-2-27c-5-5 4-5 0-10m10 10c-5-5 4-5 0-10" stroke="#f1dfb4" />
    <path d="M21 17c-1-6 5-7 9-5-1 5-4 6-9 5Z" fill="#7f9b65" strokeWidth="1.3" />
  </>,
  forest_pan: <>
    <path d="m30 22 11-17 4 3-12 18Z" fill="#b78b5d" />
    <ellipse cx="22" cy="29" rx="19" ry="12" fill="#62716a" />
    <ellipse cx="22" cy="27" rx="16" ry="8" fill="#d5a465" />
    <path d="m9 25 7-6 10 3-6 7Zm14 3 7-7 7 6-7 5Z" fill="#e8c393" strokeWidth="1.4" />
    <path d="m14 23 6 2m8 1 4 2m-21 5 4 1m9 3 3-1" stroke="#779256" strokeWidth="2.5" />
    <path d="M9 36c7 4 18 5 27-1" stroke="#9cae9b" strokeWidth="1.4" />
  </>,
  currant_glazed_fish: <>
    <ellipse cx="24" cy="32" rx="21" ry="11" fill="#cbd3b3" />
    <path d="m14 23-8-6 1 15 8-4c9 6 21 1 26-6-9-7-19-7-27 1Z" fill="#dbad70" />
    <path d="m16 22 7-4 10 2 1 5-8 5-9-2Z" fill="#785469" />
    <path d="m21 21 7 1m-10 3 9 1" stroke="#c98c9a" strokeWidth="2" />
    <circle cx="36" cy="22" r="1.3" fill="#344236" stroke="none" />
    <path d="m11 35 4-5 5 5-5 3Z" fill="#87a76d" />
    <circle cx="28" cy="36" r="3" fill="#71516d" /><circle cx="35" cy="34" r="3" fill="#9c647f" />
  </>,
  berry_pastila: <>
    <path d="m6 23 27-9 12 20-26 10Z" fill="#d8bd8e" />
    <path d="m10 22 14-5 9 15-14 5Z" fill="#b66c80" /><ellipse cx="19" cy="36" rx="5" ry="6" transform="rotate(-27 19 36)" fill="#da9b9f" />
    <path d="m25 17 8-3 8 14-9 5Z" fill="#875e79" /><ellipse cx="33" cy="31" rx="5" ry="6" transform="rotate(-27 33 31)" fill="#bf8ca7" />
    <path d="M18 33c6 0 4 6 0 4m14-9c6 0 4 6 0 4" stroke="#794e69" strokeWidth="1.4" />
    <path d="m8 13 5-6 5 6-5 4Z" fill="#9db576" /><circle cx="22" cy="10" r="3" fill="#bc7788" />
  </>,
  trail_feast: <>
    <path d="m5 17 33-7 6 26-33 8Z" fill="#95a87b" /><path d="m11 18 26-5 2 18-25 7Z" fill="#e7d4a5" />
    <path d="m14 23 7-5 9 4-4 8-9 1Z" fill="#c38955" /><path d="m19 20 6 3m-9 2 6 3" stroke="#f2cea0" />
    <path d="m28 27 6-5 4 7-6 5Z" fill="#9a6d67" /><circle cx="18" cy="35" r="3" fill="#ac6678" />
    <path d="m7 26 34-7M26 12l6 27" stroke="#bc9a61" strokeWidth="2.5" />
    <path d="M26 24c-10-8-12 4 1 3-2-12 10-8 4-2Z" fill="#c5ab7c" strokeWidth="1.4" />
  </>,
  river_aspic: <>
    <ellipse cx="24" cy="37" rx="21" ry="8" fill="#b8c9ae" />
    <path d="M7 33 12 16c2-8 22-8 24 0l5 17c-5 10-30 10-34 0Z" fill="#d0bd7b" fillOpacity=".9" />
    <ellipse cx="24" cy="16" rx="12" ry="5" fill="#e7d29b" />
    <path d="m18 27-6-4 1 9 5-3c5 4 12 2 16-3-5-5-11-5-16 1Z" fill="#eff0d0" strokeWidth="1.3" />
    <circle cx="30" cy="26" r="1" fill="#526b59" stroke="none" />
    <path d="m15 17-3 14m5 7c7 2 14 1 19-2" stroke="#f7ecc3" strokeWidth="2.5" />
    <path d="m19 15 4-3 5 3-5 2Z" fill="#82a36b" strokeWidth="1.2" />
  </>,
};

import type { ReactNode } from "react";

/** Durable tackle: the same native master is used in every shop preview. */
export const hookArt: Record<string, ReactNode> = {
  spoon_hook: <>
    <ellipse cx="27" cy="8" rx="3" ry="4" fill="none" stroke="#b8a378" strokeWidth="2" />
    <path d="M27 12c-16 5-13 18 0 20 11-6 13-16 0-20Z" fill="#ba8854" />
    <path d="M26 15c-8 4-9 10-1 13" fill="none" stroke="#e8c796" strokeWidth="2" />
    <path d="M27 31v6c0 9-12 9-12 1l3-5 1 7m8-8v5c0 8 11 9 12 1l-3-5-1 7" fill="none" stroke="#7d887c" strokeWidth="2.5" />
  </>,
  weedless_hook: <>
    <ellipse cx="30" cy="8" rx="3" ry="4" fill="none" stroke="#c4cda3" strokeWidth="3" />
    <path d="M30 12v19c0 12-19 16-20 3l6-11 2 9-4-1c0 6 10 7 11 0V12Z" fill="#728568" />
    <path d="M28 14 16 24m12-8-9 10m9-8-7 10" fill="none" stroke="#b7c78d" strokeWidth="1.7" />
    <path d="M29 16v15c0 9-13 12-16 5" fill="none" stroke="#d9dfb5" strokeWidth="1.5" />
  </>,
  moth_hook: <>
    <path d="M27 15C9 1 5 16 24 23 7 20 11 35 27 25c17 10 22-4 5-4 17-6 12-21-5-6Z" fill="#c2b0d0" />
    <path d="m12 13 12 6m17-7-10 7m-16 8 9-4m15 3-8-3" fill="none" stroke="#f0dcc4" strokeWidth="1.5" />
    <path d="M27 9v27c0 8-12 11-14 3l3-7 1 8" fill="none" stroke="#7d97a5" strokeWidth="3" />
    <ellipse cx="27" cy="8" rx="2.5" ry="3.5" fill="none" stroke="#c5d6df" strokeWidth="2" />
  </>,
  deep_hook: <>
    <path d="m26 5 6-2 5 5-2 7-7 1-5-5Z" fill="#9ea5aa" /><circle cx="30" cy="9" r="2" fill="#3b5361" />
    <path d="m29 15-3 13c-2 7-10 7-11 2l5-7-1 10-5-2c0 9 13 13 18 4 4-6 5-14 4-20Z" fill="#526f7b" />
    <path d="m31 18 5 5-7 2 5 5m-4-12-3 11c-2 8-10 9-12 5" fill="none" stroke="#c6c89f" strokeWidth="1.7" />
    <path d="m36 15 5 3-2 8-3-1Z" fill="#8e8e71" />
  </>,
  tide_hook: <>
    <path d="M28 4c-6 0-7 9-2 12v15c0 9-10 11-12 4-1-3 1-6 3-8l3 2-1-13-9 10c-7 10-3 20 7 20 11 0 16-6 16-16V16c6-5 2-12-5-12Z" fill="#6daeb0" />
    <ellipse cx="29" cy="10" rx="2" ry="3" fill="#e8edcb" />
    <path d="M29 19v12c0 11-13 14-17 6m15-18 5 3-5 3 5 3m-17-7-2 5" fill="none" stroke="#cbe8df" strokeWidth="1.8" />
    <path d="m34 14 5 2 2 5-5 2-3-3Z" fill="#5f959f" />
    <path d="m35 17 3 3" stroke="#dcecdc" />
  </>,
  leviathan_hook: <>
    <path d="m27 3 7 2 4 6-5 8v12c0 11-8 16-17 12C5 40 5 29 13 21l8-6-1 13-4-3c-5 5-5 11 1 13 6 2 10-2 10-8V18l-5-7Z" fill="#b8a266" />
    <path d="m28 7 5 1 1 4-4 3-4-4Z" fill="#aabfc7" />
    <path d="M30 21v10c0 9-8 14-15 10m-1-19 4-3" fill="none" stroke="#f0dc9e" strokeWidth="2" />
    <path d="m25 20 8 4-7 3 6 3m-18-6 6 7-6-2" fill="none" stroke="#756349" strokeWidth="1.7" />
    <path d="m38 6 1 5 5 1-5 2-1 5-2-5-4-2 4-1Z" fill="#e1d2a2" strokeWidth="1.2" />
  </>,
  bare_hook: <>
    <ellipse cx="27" cy="9" rx="4" ry="5" fill="#b4beb7" />
    <ellipse cx="27" cy="9" rx="1.3" ry="2" fill="#e8e2c9" strokeWidth="1.3" />
    <path d="M27 14v18c0 8-6 12-13 10-6-2-7-8-5-14l5-9 1 11-4-2c-1 4 0 8 4 9 4 1 7-1 7-6V14Z" fill="#8d9b95" />
    <path d="M25 17v15c0 6-5 10-10 8m-5-15 3-4" fill="none" stroke="#d6dfd5" strokeWidth="1.8" />
    <path d="m29 17 7-2 3 3" fill="none" stroke="#a6ab8d" strokeWidth="1.4" />
  </>,
  round_hook: <>
    <ellipse cx="31" cy="9" rx="4" ry="4.5" fill="#a3ad8e" />
    <ellipse cx="31" cy="9" rx="1.5" ry="2" fill="#e8e2c9" strokeWidth="1.2" />
    <path d="M33 13v16c0 11-7 16-15 14C7 41 5 31 11 23c3-4 8-6 13-4l4 4-10 1 3-3c-4 0-7 4-7 8-1 6 3 10 8 9 5-1 6-4 6-10V13Z" fill="#909a76" />
    <path d="M31 17v12c0 9-6 13-13 11-7-2-9-10-4-15m1-3 4-1" fill="none" stroke="#d8d9ac" strokeWidth="2" />
    <path d="m28 15 5 1m-5 2 5 1" fill="none" stroke="#687852" strokeWidth="1.3" />
  </>,
  barbed_hook: <>
    <ellipse cx="31" cy="8" rx="4.5" ry="4.5" fill="#b7a17b" />
    <ellipse cx="31" cy="8" rx="1.6" ry="1.6" fill="#e7ddbd" strokeWidth="1.2" />
    <path d="M32 12v17c0 11-7 17-16 13C8 39 7 31 10 24l5-10 2 11-4-2c-3 6-2 11 3 13 6 2 10-2 10-8V12Z" fill="#ac8957" />
    <path d="m13 20 5 7-5-1m17-11-3 4 5 1-5 4 5 2" fill="none" stroke="#6e5941" strokeWidth="1.6" />
    <path d="M30 28c0 9-6 15-13 12m-6-18 3-5" fill="none" stroke="#e1c291" strokeWidth="1.9" />
    <path d="m35 15 6 1-2 5-4-2Z" fill="#c48861" strokeWidth="1.3" />
  </>,
  silver_hook: <>
    <path d="m29 3 5 4-1 6-6 1-4-5 1-5Z" fill="#d6e5eb" />
    <path d="m27 7 3-1 1 3-3 2Z" fill="#819caa" strokeWidth="1.2" />
    <path d="M31 13v17c0 10-8 16-17 12C6 38 8 28 13 21l5-5 1 11-4-2c-4 6-4 10 1 12 5 2 9-2 9-8V13Z" fill="#a7bfce" />
    <path d="M29 17v12c0 9-7 14-14 11m-1-17 3-4" fill="none" stroke="#edf7f6" strokeWidth="2.2" />
    <path d="m27 16 4 2-5 3 5 3-5 3" fill="none" stroke="#6e91a6" strokeWidth="1.4" />
    <path d="m38 8 1 4 4 1-4 1-1 4-1-4-4-1 4-1Z" fill="#f4e6b1" stroke="#bba66b" strokeWidth="1.2" />
  </>,
};

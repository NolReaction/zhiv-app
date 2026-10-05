import type { ReactNode } from "react";

/** Durable tackle: the same native master is used in every shop preview. */
export const hookArt: Record<string, ReactNode> = {
  bare_hook: <>
    <ellipse cx="27" cy="9" rx="4" ry="5" fill="#b4beb7" />
    <ellipse cx="27" cy="9" rx="1.3" ry="2" fill="#e8e2c9" strokeWidth="1.3" />
    <path d="M27 14v18c0 8-6 12-13 10-6-2-7-8-5-14l5-9 1 11-4-2c-1 4 0 8 4 9 4 1 7-1 7-6V14Z" fill="#8d9b95" />
    <path d="M25 17v15c0 6-5 10-10 8m-5-15 3-4" fill="none" stroke="#d6dfd5" strokeWidth="1.8" />
    <path d="m29 17 7-2 3 3" fill="none" stroke="#a6ab8d" strokeWidth="1.4" />
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

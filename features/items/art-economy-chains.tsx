import type { ReactNode } from "react";

/** Shared illustrations for the ceramic, packing and equipment production chains. */
export const economyChainArt: Record<string, ReactNode> = {
  limestone: <>
    <path d="m6 29 7-15 13-7 13 10 4 17-16 9-19-5Z" fill="#d4ceb1" />
    <path d="m13 14 14 9 12-6M27 23v20M6 29l21-6" stroke="#a69f80" />
    <path d="m16 13 9-3 9 7m-3 12 6-3" stroke="#f0ead1" strokeWidth="3" />
    <circle cx="16" cy="31" r="1.5" fill="#aaa488" stroke="none" /><circle cx="33" cy="34" r="1.5" fill="#aaa488" stroke="none" />
  </>,
  bottled_compote: <>
    <path d="M19 10h10v10l8 8v12c-4 5-22 5-26 0V28l8-8Z" fill="#b4c7a3" />
    <path d="M12 30h24v10c-5 3-19 3-24 0Z" fill="#b46866" stroke="none" />
    <path d="M17 7h14v6H17Z" fill="#bb9769" />
    <rect x="17" y="26" width="14" height="12" rx="3" fill="#e8d6a9" />
    <circle cx="24" cy="32" r="3" fill="#bb6b68" /><path d="m24 29 3-3" stroke="#67844f" />
    <path d="M16 30v7" stroke="#f1d9c0" />
  </>,
  berry_gift: <>
    <path d="m7 20 17-7 17 7v20l-17 6-17-6Z" fill="#c8aa76" />
    <path d="m7 20 17 6 17-6M24 26v20" />
    <path d="m17 16 17 7v20l-6 2V25L11 18Z" fill="#b66d65" />
    <path d="M25 16C9 15 11 4 18 7l7 9c-3-16 11-14 10-7-1 4-6 6-10 7Z" fill="#d58b78" />
    <path d="m13 29 5 2v6l-5-2Z" fill="#ead9b0" />
  </>,
  ceramic_jar: <>
    <path d="M16 10h16v7c6 5 8 11 6 20-3 7-25 7-28 0-2-9 0-15 6-20Z" fill="#c68b60" />
    <ellipse cx="24" cy="10" rx="9" ry="3" fill="#a66c49" />
    <path d="M14 24c6 3 14 3 20 0M13 34c7 3 15 3 22 0" stroke="#f1cf91" strokeWidth="3" />
    <path d="M16 19c-3 4-4 8-3 11" stroke="#edd0a4" />
  </>,
  mortar: <>
    <path d="m9 23 5 17c6 4 15 4 21 0l5-17Z" fill="#b5a47e" />
    <ellipse cx="24.5" cy="23" rx="15.5" ry="6" fill="#d9d0b4" />
    <path d="m15 23 5-4 7 2 5-2 5 5" stroke="#8e967e" />
    <path d="m28 19 8-13 5 3-8 13Z" fill="#a8885f" />
    <path d="M18 28v8m7-6v9m7-10-2 8" stroke="#e5d4a8" />
  </>,
  glass_bottle: <>
    <path d="M19 9h10v12l7 7v11c-3 6-21 6-24 0V28l7-7Z" fill="#a2c6b8" />
    <path d="M18 7h12v5H18Z" fill="#b79568" />
    <path d="M13 32c7 3 15 3 22 0v6c-2 4-20 4-22 0Z" fill="#75ad9c" stroke="none" />
    <path d="M21 16v8l-5 6v7" stroke="#e2f1d9" strokeWidth="3" />
    <path d="M22 40h7" stroke="#d1e8cf" />
  </>,
  lens: <>
    <path d="m29 32 10 10 5-5-10-10Z" fill="#a58358" />
    <circle cx="22" cy="21" r="16" fill="#c6ad72" />
    <circle cx="22" cy="21" r="12" fill="#a9d2ca" />
    <path d="M14 23c-2-5 0-10 6-12m5 20 5-5" stroke="#edf5de" strokeWidth="3" />
    <path d="m13 29 13-15" stroke="#cde8d4" />
  </>,
  packed_berries: <>
    <path d="M13 16h22l3 20c0 8-28 8-28 0Z" fill="#be8968" />
    <path d="m10 12 7-4 7 3 7-3 7 4-3 7H13Z" fill="#d9bd8c" />
    <path d="M12 19h24" stroke="#88724f" strokeWidth="3" />
    <rect x="15" y="25" width="18" height="13" rx="3" fill="#f0ddb0" />
    <path d="m23 28 2-4 3 1" stroke="#5f8055" />
    <circle cx="21" cy="31" r="3" fill="#b96669" /><circle cx="26" cy="31" r="3" fill="#b96669" />
    <circle cx="23.5" cy="34" r="3" fill="#a65361" />
  </>,
  trade_crate: <>
    <path d="m7 15 16-8 18 8v24l-17 6-17-6Z" fill="#b88d59" />
    <path d="m7 15 17 7 17-7M24 22v23" />
    <path d="m8 24 15 6 17-6M8 32l15 6 17-6" stroke="#785a3f" />
    <path d="m13 12 18 7v12l5-2V17L19 9Z" fill="#ddc8a0" />
    <path d="m12 26 6 2m11 8 7-2" stroke="#ebcb8c" />
  </>,
  field_kit: <>
    <path d="M11 18c0-7 26-7 26 0l3 21c-6 6-25 6-31 0Z" fill="#7d9673" />
    <path d="M18 15V9c0-4 12-4 12 0v6" stroke="#8d704b" strokeWidth="4" />
    <path d="M10 19h28l-3 11H13Z" fill="#abc296" />
    <path d="M21 23h6v10h-6Z" fill="#d6b36b" />
    <path d="M15 35v5m18-5v5" stroke="#c4d2a7" />
    <path d="m35 12 6-6m-4-1 5 5" stroke="#c1bb9b" strokeWidth="4" />
  </>,
  stone_tile: <>
    <path d="m5 29 17-11 20 9v8L25 46 5 37Z" fill="#8c9a91" />
    <path d="m5 29 20 9 17-11M25 38v8" />
    <path d="m7 17 17-11 18 9v8L25 34 7 25Z" fill="#b6bca4" />
    <path d="m7 17 18 9 17-11M25 26v8" />
    <path d="m15 16 10 4 8-5" stroke="#e0dbc0" />
  </>,
  quartz: <>
    <path d="m7 30 5-14 8-6 7 8 7-4 7 16-13 12-17-4Z" fill="#c5ddd6" />
    <path d="m20 10 4 17 4 15 6-28M7 30l17-3 17 3M12 16l12 11-13 11" stroke="#729b94" />
    <path d="m15 18 3-4 3 10m13-3 3 7" stroke="#f0f4dd" strokeWidth="3" />
  </>,
};

import { useId } from "react";

/** Menu illustration. The map keeps its own lightweight, world-scaled boat. */
export function BoatArt({ repaired = true, crate = false, oars = false, net = false, telescope = false, travelling = false }: {
  repaired?: boolean; crate?: boolean; oars?: boolean; net?: boolean; telescope?: boolean; travelling?: boolean;
}) {
  const id = useId().replace(/:/g, "");
  return <svg viewBox="0 0 560 270" role="img" aria-label={repaired ? "Рыбацкая лодка с установленным снаряжением" : "Старая лодка ждёт ремонта"} data-boat-art={repaired ? "repaired" : "broken"} data-travelling={travelling || undefined}>
    <defs>
      <linearGradient id={`${id}-water`} x2="0" y2="1"><stop stopColor="#294d4a" /><stop offset="1" stopColor="#173d43" /></linearGradient>
      <linearGradient id={`${id}-hull`} x2="0" y2="1"><stop stopColor="#b99152" /><stop offset="1" stopColor="#725434" /></linearGradient>
      <radialGradient id={`${id}-sun`}><stop stopColor="#dfd79a" stopOpacity=".17" /><stop offset="1" stopColor="#d4daaa" stopOpacity="0" /></radialGradient>
    </defs>
    <rect width="560" height="270" rx="20" fill={`url(#${id}-water)`} />
    <ellipse cx="295" cy="77" rx="220" ry="160" fill={`url(#${id}-sun)`} />
    <g fill="none" stroke="#78a399" strokeLinecap="round" opacity=".24">
      <path d="M53 68h47m12 0h16m267 23h52m-406 89h55m337 20h61M178 39h29m222 3h36M56 232h73m80 13h91m98-15h45" />
      <path d="M124 182q140 46 298-8m-279 23q133 34 244-1m-309-73 15 0m327 21h28" strokeWidth="2" />
    </g>
    <g fill="#527a62"><path d="M0 204q30-42 66-14-43 3-48 35 39-23 61 2-39 1-54 22L0 259Z" /><path d="M560 0h-87q33 10 44 30-36-13-47 4 37 3 58 27-38-9-42 10 40 4 74 29Z" /></g>
    <g stroke="#a4af72" strokeWidth="3" fill="none" opacity=".75"><path d="m34 258 4-65m1 37 18-35m-20 25-14-35M523 59l-5-35m3 23 18-19" /></g>
    <g data-boat-hull>
      <ellipse cx="280" cy="177" rx="158" ry="28" fill="#0c2833" opacity=".4" />
      <path d="M123 107q142-67 300-5l-22 62q-123 65-256 0Z" fill="#352f29" stroke="#d0b173" strokeWidth="5" strokeLinejoin="round" />
      <path d="M143 112q120-48 260-5l-20 40q-111 46-218 1Z" fill="#655337" />
      <path d="M155 118q113-37 235-8m-225 19q102-32 216-9m-204 21q93-26 192-11" fill="none" stroke="#8b7146" strokeWidth="5" />
      <path d="M123 107q130 73 300-5l-22 62q-123 65-256 0Z" fill={`url(#${id}-hull)`} stroke="#59442e" strokeWidth="3" strokeLinejoin="round" />
      <path d="M134 130q132 68 282-8m-272 28q119 57 264-7m-257 23q109 46 248-4" fill="none" stroke="#5a442e" strokeWidth="2" />
      <path d="M125 108q134 69 297-6" fill="none" stroke="#e4c58a" strokeWidth="7" strokeLinecap="round" />
      <path d="m205 95 31 17m83-23 28 18" stroke="#d9b97c" strokeWidth="13" />
      <path d="m205 98 31 17m83-23 28 18" stroke="#715a37" strokeWidth="2" />
      <g fill="#d8bf82"><circle cx="156" cy="146" r="3" /><circle cx="210" cy="164" r="3" /><circle cx="278" cy="172" r="3" /><circle cx="348" cy="159" r="3" /><circle cx="393" cy="139" r="3" /></g>
      {!repaired && <><path d="m286 155 12-12 13 13 14-7-5 26-22 12-8-16-14-4Z" fill="#183c3e" /><path d="m285 149 16-21 10 20m15 8 11-10" fill="none" stroke="#473a29" strokeWidth="4" /><path d="m180 89 34 29m144-30-25 25" stroke="#75916c" strokeWidth="6" opacity=".65" /></>}
      {repaired && <g stroke={oars ? "#e1c28a" : "#ad8d5d"} strokeWidth={oars ? 7 : 5} strokeLinecap="round"><path d="m238 112-78 82m160-86 73 90" /><path d="m160 194-12 13m245-9 12 14" strokeWidth={oars ? 19 : 15} /></g>}
      {crate && <g data-boat-part="crate" stroke="#5c4931" strokeWidth="2"><path d="m284 107 37-9 28 16-38 10Z" fill="#c3ab74" /><path d="m284 107 27 17v24l-27-17Z" fill="#967b4f" /><path d="m311 124 38-10v24l-38 10Z" fill="#b1945b" /><path d="m288 116 20 12m-20-3 20 12m10-9 26-8m-26 17 26-8" /><path d="m305 102 24 17" stroke="#e1cc96" strokeWidth="5" /></g>}
      {net && <g data-boat-part="landing_net" stroke="#dbcfa0" fill="none" strokeWidth="3"><path d="m368 106 39-62" stroke="#ae8954" strokeWidth="6" /><ellipse cx="414" cy="32" rx="18" ry="27" transform="rotate(30 414 32)" /><path d="m404 14 17 29m-25-16 25 13m-14-22-9 25m23-22-9 30" strokeWidth="1" opacity=".8" /></g>}
      {telescope && <g data-boat-part="telescope" stroke="#62523a" strokeWidth="2"><path d="m187 107 5-29" strokeWidth="6" /><path d="m185 72 42-18 5 12-42 18Z" fill="#c9ab65" /><path d="m220 52 11-5 8 18-11 5Z" fill="#dcca8d" /><path d="m232 49 5 13" stroke="#9ac3ba" strokeWidth="5" /></g>}
      <path d="M124 108q-41 5-37 36 2 17 20 12" stroke="#b3ab83" strokeWidth="3" fill="none" />
    </g>
  </svg>;
}

export function BlueprintArt({ kind, complete = false }: { kind: "landing_net" | "telescope"; complete?: boolean }) {
  return <svg viewBox="0 0 100 100" width="78" height="78" aria-hidden="true" data-boat-blueprint-art={kind}>
    <rect x="7" y="5" width="86" height="90" rx="9" fill={complete ? "#dce5c8" : "#dce5de"} stroke="#9eae98" />
    <path d="M17 26h66M17 48h66M17 70h66M29 15v70M51 15v70M73 15v70" stroke="#b7c8b9" opacity=".6" />
    {kind === "landing_net" ? <g fill="none" stroke="#4f7567" strokeLinecap="round"><path d="m32 80 24-33" strokeWidth="6" /><ellipse cx="64" cy="34" rx="16" ry="23" transform="rotate(35 64 34)" strokeWidth="3" /><path d="m52 22 20 28M49 32l28 7m-14-24-14 29m28-20L61 56" strokeWidth="1.5" /></g>
      : <g stroke="#4f7567" strokeWidth="2" fill="#c8d8c7"><path d="m22 56 48-24 8 15-48 24Z" /><path d="m65 29 11-6 13 25-11 6Z" /><path d="m19 57 8-4 10 19-8 4Z" /><path d="m47 66-5 17m12-21 13 17" fill="none" strokeWidth="3" /></g>}
  </svg>;
}

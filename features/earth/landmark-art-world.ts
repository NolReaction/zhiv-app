import type { EarthLandmarkKind } from "./landmark-catalog";

// Original miniature drawings. The shared 100×120 viewBox lands at [50,112].
// All shapes are local SVG geometry: no assets, fonts, IDs or active markup.
const outline = 'stroke="#58776a" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"';
const shadow = '<ellipse cx="50" cy="108" rx="41" ry="4" fill="#244b48" opacity=".17"/>';

const giza = `${shadow}<g ${outline}>
  <path d="M6 96 49 82 95 98 50 112 6 103Z" fill="#ddbd81"/>
  <path d="M6 96 49 82 95 98 54 107Z" fill="#f0d79b" stroke="none"/>
  <path d="M73 43 50 82 75 94 95 81Z" fill="#e6c382"/>
  <path d="M73 43 75 94 95 81Z" fill="#be925f"/>
  <path d="M45 26 10 86 49 105 83 85Z" fill="#efcf8c"/>
  <path d="M45 26 49 105 83 85Z" fill="#c49a64"/>
  <path d="M45 26 43 83 10 86Z" fill="#f7dfa1" stroke="none"/>
  <path d="M34 46 48 49M26 60 48 67M18 74 48 86" fill="none" stroke="#d8b67b" stroke-width="1"/>
  <path d="M57 47 48 49M65 61 48 67M74 75 48 86" fill="none" stroke="#b58b59" stroke-width="1"/>
  <path d="M20 65 3 96 23 105 40 96Z" fill="#e7c488"/>
  <path d="M20 65 23 105 40 96Z" fill="#b78b5a"/>
  <path d="M66 102 71 100 75 102 70 104Z" fill="#ccb17b" stroke="none"/>
  <path d="M82 96 86 94 89 96 85 98Z" fill="#ccb17b" stroke="none"/>
</g>`;

function minaret(x: number, y: number, height: number): string {
  return `<g transform="translate(${x} ${y})">
    <path d="M-3 9H3L4 ${height}H-4Z" fill="#fff5db"/>
    <path d="M1 9H3L4 ${height}H1Z" fill="#bdcbb4" stroke="none"/>
    <path d="M-4 8Q-4 3 0 1 4 3 4 8Z" fill="#fffbe8"/>
    <path d="M0 1V-2M-4 10H4M-4 ${height - 8}H4" fill="none"/>
  </g>`;
}

const taj = `${shadow}<g ${outline}>
  <path d="M5 96 47 82 95 98 50 112 5 103Z" fill="#b6c7af"/>
  <path d="M5 96 47 82 95 98 53 107Z" fill="#e4e7cb"/>
  ${minaret(20, 43, 48)}${minaret(80, 43, 48)}
  <path d="M22 65 50 58 79 67 79 94 51 105 22 94Z" fill="#dce0c8"/>
  <path d="M29 61H68V100H29Z" fill="#fff6dc"/>
  <path d="M68 61 79 67V94L68 100Z" fill="#bfcbb6"/>
  <path d="M25 64Q23 56 29 52 35 57 34 64Z" fill="#fffbe8"/>
  <path d="M66 64Q65 56 71 52 78 57 76 65Z" fill="#f1f0d8"/>
  <path d="M32 59C30 47 43 42 47 32L50 25 53 33C59 42 70 47 68 59Q51 67 32 59Z" fill="#fffbe8"/>
  <path d="M50 25C49 41 64 47 60 62L68 59C70 47 59 42 53 33Z" fill="#d4ddc5" stroke="none"/>
  <path d="M34 60Q50 65 66 60M50 25V18" fill="none"/>
  <circle cx="50" cy="17" r="1.6" fill="#d9b56c" stroke="none"/>
  <path d="M41 99V82Q41 75 49 71 57 75 57 82V99Z" fill="#6c9690"/>
  <path d="M44 99V83Q44 78 49 75 52 77 53 80V99Z" fill="#83ada0" stroke="none"/>
  <path d="M33 84V77Q35 73 38 77V84ZM60 84V77Q63 73 65 77V84Z" fill="#9ab8a5"/>
  <path d="M32 91H38M60 91H66M29 68H68" fill="none" stroke="#b6c5ad"/>
  ${minaret(10, 61, 42)}${minaret(90, 61, 42)}
</g>`;

function wallTower(x: number, y: number, scale: number): string {
  return `<g transform="translate(${x} ${y}) scale(${scale})">
    <path d="M-8-18H7V0H-8Z" fill="#dfcea6"/>
    <path d="M7-18 13-22V-4L7 0Z" fill="#ab9779"/>
    <path d="M-8-18-2-22H13L7-18Z" fill="#f1e1bb"/>
    <path d="M-9-18V-24H-5V-21H-1V-24H3V-21H7V-24L13-27V-21L7-18Z" fill="#dfcea6"/>
    <path d="M-3 0V-7Q0-11 3-7V0" fill="#78816f"/>
    <path d="M-5-13H-3M2-13H4" stroke="#9c9a7c" stroke-width="2"/>
  </g>`;
}

const greatWall = `${shadow}<g ${outline}>
  <path d="M5 98Q12 79 27 81 38 60 49 65 65 39 79 52L97 99Q77 112 50 112 22 110 5 104Z" fill="#7eae80"/>
  <path d="M5 98Q12 79 27 81 38 60 49 65 65 39 79 52L72 82 48 91 28 102Z" fill="#acd08b" stroke="none"/>
  <path d="M13 98 28 88 40 93 56 77 69 81 88 62" fill="none" stroke="#a28f73" stroke-width="11"/>
  <path d="M13 92 28 82 40 87 56 71 69 75 88 56" fill="none" stroke="#e5d6ae" stroke-width="9"/>
  <path d="M13 92 28 82 40 87 56 71 69 75 88 56" fill="none" stroke="#9e9277" stroke-width="1.4"/>
  <path d="M11 90V86L15 83V87L20 84V80L24 77V81L28 78 33 80V76L37 78V82L40 83 45 78V74L49 70V74L54 69 59 69V65L63 67V71L68 72 72 68V64L76 60V64L81 59V55L85 51V55" fill="none" stroke="#e9d9b3" stroke-width="2.6"/>
  ${wallTower(85, 61, 0.8)}${wallTower(55, 80, 0.88)}${wallTower(22, 99, 1)}
  <path d="M8 103 15 101M72 103 80 100M79 94 84 92" fill="none" stroke="#649773" stroke-width="2"/>
</g>`;

const liberty = `${shadow}<g ${outline}>
  <path d="M23 103 49 94 78 105 50 112Z" fill="#8cb894"/>
  <path d="M29 103 50 96 72 104 51 111Z" fill="#ddc59b"/>
  <path d="M37 80H61L66 103 49 109 34 103Z" fill="#dec49a"/>
  <path d="M61 80 67 84 71 103 66 105Z" fill="#ab9779"/>
  <path d="M34 79 50 74 67 80 51 86Z" fill="#eee0b8"/>
  <path d="M44 91H55V101H44Z" fill="#b19f80" stroke="none"/>
  <path d="M43 49 36 42 28 26 24 28 30 49 42 61Z" fill="#9ccfb2"/>
  <path d="M27 28 31 45 42 55 42 61 30 49 24 28Z" fill="#67a68e" stroke="none"/>
  <path d="M43 49Q50 46 58 50L61 64 65 84Q50 92 35 84L39 64Z" fill="#a8d5b6"/>
  <path d="M51 51 59 53 61 64 65 84 51 88 53 69Z" fill="#6ba58e" stroke="none"/>
  <path d="M44 56 43 80M48 65 46 85M57 69 60 83" fill="none" stroke="#75b397"/>
  <path d="M58 50 66 56 70 68 63 71 57 60Z" fill="#92c5aa"/>
  <path d="M62 56 73 60 69 76 59 72Z" fill="#649d89"/>
  <path d="M64 62 69 64M63 66 68 68" fill="none" stroke="#aed6b8"/>
  <path d="M45 48V42H55V49" fill="#9bcdb0"/>
  <ellipse cx="50" cy="40" rx="6.2" ry="7.2" fill="#b5dcbc"/>
  <path d="M50 34Q57 35 56 41L53 47H50" fill="#83b89f" stroke="none"/>
  <path d="M44 38 39 30 46 34 46 25 51 33 56 25 56 35 64 31 58 40Z" fill="#87bda1"/>
  <path d="M44 38Q50 35 58 39" fill="none" stroke="#5b927e" stroke-width="2"/>
  <path d="M24 27V19H31V27" fill="#79b49b"/>
  <path d="M23 18H32L30 21H25Z" fill="#7d9b7e"/>
  <path d="M28 6C28 12 21 12 24 17Q28 21 32 16C35 12 30 11 28 6Z" fill="#f5c66c" stroke="#b38d56"/>
  <path d="M28 12Q25 17 29 17" fill="none" stroke="#fff2b8" stroke-width="2"/>
</g>`;

const christ = `${shadow}<g ${outline}>
  <path d="M13 104Q21 89 36 91L45 79 59 88Q78 86 88 104L50 112Z" fill="#78a980"/>
  <path d="M13 104Q21 89 36 91L45 79 51 94 50 112Z" fill="#acd08f" stroke="none"/>
  <path d="M30 94 50 88 70 95 50 103Z" fill="#dfd9ba"/>
  <path d="M30 94V99L50 108V103Z" fill="#a4af98"/>
  <path d="M50 103 70 95V100L50 108Z" fill="#879e8f"/>
  <path d="M39 84H60L63 96 49 101 36 96Z" fill="#d5d9bd"/>
  <path d="M42 42 29 46 11 43 8 49 31 57 41 54 36 88Q50 94 65 88L60 54 72 57 92 49 89 43 71 46 58 42Z" fill="#edf0d5"/>
  <path d="M51 44 58 42 60 54 65 88 51 91 53 65Z" fill="#b6c5ae" stroke="none"/>
  <path d="M8 49 31 57 41 54 42 50 31 52Z" fill="#c6d1b8" stroke="none"/>
  <path d="M60 50 72 52 92 49 72 57 60 54Z" fill="#aebfa9" stroke="none"/>
  <path d="M44 56 42 85M49 60 48 88M57 67 59 85" fill="none" stroke="#9cae99"/>
  <path d="M45 43V36H55V43" fill="#d6dfc4"/>
  <ellipse cx="50" cy="32" rx="6.8" ry="8.5" fill="#e9ebcf"/>
  <path d="M51 24Q58 26 56 34L53 40H50" fill="#becdb3" stroke="none"/>
  <path d="M45 29Q48 26 54 29M50 32V35" fill="none" stroke="#96aa96"/>
  <path d="M21 104 29 102M70 105 76 102" fill="none" stroke="#598e70" stroke-width="2"/>
</g>`;

const sydney = `${shadow}<g ${outline}>
  <path d="M5 99 48 84 96 100 50 112Z" fill="#82c8c5"/>
  <path d="M14 94 56 81 90 94 49 109 14 102Z" fill="#bba780"/>
  <path d="M14 94 56 81 90 94 49 105Z" fill="#ecd6a6"/>
  <path d="M19 83 61 74 85 88 45 101 19 94Z" fill="#c7ad86"/>
  <path d="M45 93 85 81V89L45 101Z" fill="#9a927b"/>
  <path d="M26 89V95M34 87V98M52 91V97M63 87V93M74 84V90" fill="none" stroke="#647d75" stroke-width="2"/>
  <path d="M20 42C20 58 15 72 11 84L43 88C37 65 29 50 20 42Z" fill="#f7f4db"/>
  <path d="M20 42C29 62 28 79 29 86L43 88C37 65 29 50 20 42Z" fill="#c5d2bf" stroke="none"/>
  <path d="M77 39C83 58 85 70 92 81L61 90C60 67 66 50 77 39Z" fill="#f5f3dc"/>
  <path d="M77 39C76 57 80 73 81 84L92 81C85 70 83 58 77 39Z" fill="#bdcebd" stroke="none"/>
  <path d="M42 26C24 40 16 59 14 83L48 92C39 68 39 44 42 26Z" fill="#fff9e6"/>
  <path d="M42 26C33 46 31 67 32 87L48 92C39 68 39 44 42 26Z" fill="#d6dfcb" stroke="none"/>
  <path d="M61 20C47 35 38 58 38 92L72 89C62 67 58 43 61 20Z" fill="#fffbe8"/>
  <path d="M61 20C51 48 51 70 54 91L72 89C62 67 58 43 61 20Z" fill="#d2ddc8" stroke="none"/>
  <path d="M77 52C65 58 57 73 56 94L88 86C80 75 77 63 77 52Z" fill="#fff9e5"/>
  <path d="M77 52C69 67 68 81 70 91L88 86C80 75 77 63 77 52Z" fill="#cfdbc6" stroke="none"/>
  <path d="M10 104 20 107M74 106 84 103" fill="none" stroke="#caeee0" stroke-width="1.6"/>
</g>`;

export function earthWorldLandmarkArt(kind: EarthLandmarkKind): string | null {
  switch (kind) {
    case "giza-pyramids": return giza;
    case "taj-mahal": return taj;
    case "great-wall": return greatWall;
    case "statue-of-liberty": return liberty;
    case "christ-redeemer": return christ;
    case "sydney-opera": return sydney;
    default: return null;
  }
}

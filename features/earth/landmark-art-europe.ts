import type { EarthLandmarkKind } from "./landmark-catalog";

// Original miniatures. Only trusted SVG inner markup: a 100×120 canvas whose
// ground contact is [50, 112]. No images, fonts, definitions or shared SVG IDs.
const EIFFEL_TOWER = `
<ellipse cx="50" cy="111" rx="35" ry="4" fill="#315b54" opacity=".13"/>
<g stroke-linejoin="round" stroke-linecap="round">
<path d="M46 67 50 68 39 108H31Z" fill="#98684f"/>
<path d="m51 68 5-2 14 42h-9Z" fill="#875f4b"/>
<path d="M47 14h7l6 44 8 21 18 30H73L56 79H44l-17 30H14l19-30 8-22Zm1 15h5l2 14h-9Zm-3 19h11l2 10H43Zm-4 15h18l4 11H37Z" fill="#bd8c68" fill-rule="evenodd" stroke="#775b4b" stroke-width="1.7"/>
<path d="m52 15 2 0 6 43 8 21 18 30h-8L62 80l-9-22Z" fill="#9e7055"/>
<path d="m48 29 5 0 2 14h-9Zm-3 19h11l2 10H43Zm-4 15h18l4 11H37Z" fill="none" stroke="#e4c39a" stroke-width="1.2"/>
<path d="m43 63 13 10m2-10L42 74M46 48l10 9m-1-9-11 9m4-26 5 9m-1-9-5 9" fill="none" stroke="#92684f" stroke-width="2"/>
<path d="M29 106c6-22 36-22 42 0" fill="none" stroke="#805e4c" stroke-width="4"/>
<path d="m34 79-13 26m17-26-6 18m29-18 14 26m-12-27 5 17" fill="none" stroke="#edc79b" stroke-width="2"/>
<path d="m23 99 6-1m-3-7 7 1m39 5 6 2m-14-7 7-1" fill="none" stroke="#805e4c" stroke-width="2"/>
<path d="m35 75 29-2 6 5-33 4-7-3Z" fill="#efcda1" stroke="#8c6851" stroke-width="1.3"/>
<path d="m30 79 7 3 33-4v5l-34 4-6-3Z" fill="#a27456"/>
<path d="m39 54 21-2 5 4-25 3-5-3Z" fill="#f1d6ac" stroke="#8c6851" stroke-width="1.2"/>
<path d="m35 56 5 3 25-3v5l-25 3-5-3Z" fill="#a47657"/>
<path d="m45 25 10-1 3 3-12 2-3-2Z" fill="#edc99e"/>
<path d="m43 27 3 2 12-2v4l-13 1-2-2Z" fill="#94694f"/>
<path d="M50 5v10" stroke="#80604d" stroke-width="3"/>
<path d="M47 15h7l-1-5h-5Z" fill="#d2a57a"/>
<path d="m14 109 13-1 3 3-16 2Z" fill="#e8d1aa"/>
<path d="m72 108 14 1v4l-16-2Z" fill="#cdb28e"/>
<path d="M18 107h8m49 0h8" stroke="#815f4b" stroke-width="2"/>
</g>`;

function colosseumArcades(): string {
  const columns = [15, 27, 40, 53, 66, 79, 88];
  return columns.flatMap((x, column) => {
    const curve = Math.round(9 * (1 - ((x - 51) / 44) ** 2));
    const width = column === 0 || column === 6 ? 4 : 7;
    return [50, 67, 84].map(y => {
      const top = y + curve;
      return `<path d="M${x} ${top + 11}v-7a${width / 2} 4 0 0 1 ${width} 0v7Z"/>`;
    });
  }).join("");
}

const COLOSSEUM = `
<ellipse cx="50" cy="111" rx="43" ry="5" fill="#315b54" opacity=".13"/>
<path d="M8 45C8 21 92 19 94 43v44c-1 31-85 33-86 4Z" fill="#d9af7e" stroke="#957957" stroke-width="1.5" stroke-linejoin="round"/>
<path d="M8 45c5 24 79 26 86-2v44c-1 30-85 33-86 4Z" fill="#ebc995"/>
<path d="M73 59c12-3 19-8 21-16v44c0 12-9 19-24 23Z" fill="#cba373"/>
<path d="M18 44c1-16 64-17 65-1v7c-8 14-57 15-65 1Z" fill="#926e51"/>
<ellipse cx="50" cy="48" rx="27" ry="9" fill="#b89667"/>
<path d="M8 45C8 21 92 19 94 43c0 27-85 30-86 2Zm10-1c-1 17 65 17 65-1C82 27 19 28 18 44Z" fill="#f6ddb0" fill-rule="evenodd"/>
<path d="M11 47c8 21 76 22 81-1M9 66c14 19 68 21 84-2M9 84c15 19 68 21 84-2M12 101c20 17 60 17 79-1" fill="none" stroke="#fff0ce" stroke-width="2.8"/>
<path d="M9 69c17 19 67 20 84-2M10 87c17 19 65 20 82-2" fill="none" stroke="#b28b60" stroke-width="1.3"/>
<g fill="#8d6d50">${colosseumArcades()}</g>
<path d="M22 36v-6m12 2v-6m12 5v-6m12 6v-6m12 7v-5m11 9v-5" fill="none" stroke="#ab845b" stroke-width="3.2"/>
<path d="m11 40 4-7 6-3v7l-5 2-2 7Z" fill="#d8b581"/>
<path d="M24 59v39m13-34v39m13-37v40m13-41v39m13-43v39" fill="none" stroke="#fff0cb" stroke-width="1.4"/>
<path d="M7 105c23 14 63 14 85-3l2 4c-21 17-64 18-88 4Z" fill="#bd996f"/>
`;

function onionDome(x: number, y: number, radius: number, color: string, stripe: string): string {
  return `<path d="M${x - radius} ${y}c-3-8 ${radius - 4}-${radius + 5} ${radius}-${radius + 12}c4 7 ${radius + 3} ${radius + 4} ${radius} ${radius + 12}q-${radius} 6-${radius * 2} 0Z" fill="${color}"/>
<path d="M${x} ${y - radius - 12}c-5 8 7 13 0 ${radius + 14}m-${radius - 2}-${radius - 1}c5 2 9 5 8 ${radius}" fill="none" stroke="${stripe}" stroke-width="2.7"/>
<path d="M${x - radius} ${y + 1}q${radius} 4 ${radius * 2} 0" fill="none" stroke="#805d4b" stroke-width="1.7"/>
<path d="M${x} ${y - radius - 14}v-6m-3 2h6" fill="none" stroke="#b98e4c" stroke-width="1.8" stroke-linecap="round"/>`;
}

const SAINT_BASILS = `
<ellipse cx="50" cy="111" rx="41" ry="5" fill="#315b54" opacity=".14"/>
<path d="m13 104 36-8 38 7 6 8-43 3-43-3Z" fill="#e1c39a"/>
<path d="M13 59h20v46H13Z" fill="#be6957"/><path d="M25 59h8v46h-8Z" fill="#9c5149"/>
<path d="M68 54h19v51H68Z" fill="#cb7a5e"/><path d="M80 54h7v51h-7Z" fill="#a9584c"/>
<path d="m12 60 10-13 12 12Z" fill="#699b73"/>
<path d="m67 55 10-12 12 12Z" fill="#d6ad62"/>
${onionDome(22, 49, 9, "#5d9574", "#e4d68d")}
${onionDome(77, 44, 9, "#e4b55c", "#faf0bc")}
<path d="m39 63 11-8 12 8v44H39Z" fill="#c66655"/><path d="m51 59 11 4v44H51Z" fill="#9f5049"/>
<path d="m37 64 13-41 14 41Z" fill="#518b71" stroke="#396a60" stroke-width="1.2"/>
<path d="m50 25 4 39h10Z" fill="#39715f"/>
<path d="m43 47 7-5 8 5m-17 9 9-6 11 6" fill="none" stroke="#eddda8" stroke-width="2.4"/>
<path d="M46 69h8v10h-8Zm0 18h8v12h-8Z" fill="#efd2a0"/>
<path d="M49 72h3v6h-3Zm0 18h3v8h-3Z" fill="#76554a"/>
${onionDome(50, 28, 6, "#d9b45b", "#f7e2a0")}
<path d="m28 75 10-11 11 11Z" fill="#629b7b"/>
<path d="M28 75h21v34H28Z" fill="#bf6252"/><path d="M40 75h9v34h-9Z" fill="#9e514a"/>
<path d="M59 74h22v34H59Z" fill="#d68463"/><path d="M73 74h8v34h-8Z" fill="#b66653"/>
<path d="m58 74 12-13 13 13Z" fill="#599eaa"/>
${onionDome(39, 64, 9, "#cc7464", "#fff0cd")}
${onionDome(70, 62, 10, "#66aebd", "#eee7b4")}
<path d="M17 75h11v32H17Z" fill="#d98b6d"/><path d="M19 80h7v23h-7Z" fill="#f3d9ac"/>
${onionDome(22, 71, 8, "#c6a455", "#6c9e76")}
<path d="M32 88h7v12h-7Zm31-3h7v13h-7ZM17 64h5v8h-5Zm57-5h5v7h-5Z" fill="#f6dfb2"/>
<path d="M34 90h3v8h-3Zm31-3h3v9h-3Z" fill="#795a4c"/>
<path d="M29 103h19v7H29Zm30-2h22v8H59Z" fill="#f2d9ae"/>
<path d="m42 109 8-9 8 9v4H42Z" fill="#8d5147"/>
<path d="M47 112v-5a3 3 0 0 1 6 0v5" fill="#eed4a5"/>
`;

export function earthEuropeLandmarkArt(kind: EarthLandmarkKind): string | null {
  switch (kind) {
    case "eiffel-tower": return EIFFEL_TOWER;
    case "colosseum": return COLOSSEUM;
    case "saint-basils": return SAINT_BASILS;
    default: return null;
  }
}

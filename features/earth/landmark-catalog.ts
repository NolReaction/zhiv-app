export type EarthLandmarkKind =
  | "giza-pyramids"
  | "eiffel-tower"
  | "colosseum"
  | "saint-basils"
  | "taj-mahal"
  | "great-wall"
  | "statue-of-liberty"
  | "christ-redeemer"
  | "sydney-opera";

export interface EarthLandmark {
  readonly id: string;
  readonly nameRussian: string;
  /** Approximate WGS84 longitude/latitude of the monument or named site. */
  readonly location: readonly [number, number];
  readonly kind: EarthLandmarkKind;
  /** Monument owner, heritage authority or official local tourism office. */
  readonly sourceUrl: string;
  /** Coordinate provenance is separate when the context page has no numbers. */
  readonly coordinateSourceUrl: string;
  readonly coordinateNote: string;
}

/**
 * Public atlas anchors, not user locations, building footprints or navigation
 * fixes. Values are rounded to five decimal places; that is storage precision,
 * not a claim of metre accuracy. Artwork and its screen size are independent.
 * No images or models from the linked sources are bundled with this catalogue.
 */
export const EARTH_LANDMARKS: readonly EarthLandmark[] = [
  {
    id: "giza-pyramids", kind: "giza-pyramids", nameRussian: "Пирамиды Гизы",
    location: [31.13041, 29.97604],
    sourceUrl: "https://whc.unesco.org/en/list/86/",
    coordinateSourceUrl: "https://whc.unesco.org/en/list/86/maps/",
    coordinateNote: "Точка UNESCO 86-002 у пирамиды Хефрена: N29 58 33.744, E31 7 49.476. Обозначает комплекс Гизы, не все поля до Дахшура.",
  },
  {
    id: "eiffel-tower", kind: "eiffel-tower", nameRussian: "Эйфелева башня",
    location: [2.29444, 48.85826],
    sourceUrl: "https://www.toureiffel.paris/en/access-map",
    coordinateSourceUrl: "https://parisjetaime.com/eng/culture/la-tour-eiffel-p3486",
    coordinateNote: "Маркер La tour Eiffel официального туристического офиса Парижа: data-longitude 2.2944366932, data-latitude 48.8582572937; округлён.",
  },
  {
    id: "colosseum", kind: "colosseum", nameRussian: "Колизей",
    location: [12.49244, 41.88937],
    sourceUrl: "https://colosseo.it/en/area/colosseo/",
    coordinateSourceUrl: "https://www.turismoroma.it/en/places/flavian-amphitheatre-colosseum",
    coordinateNote: "Официальная точка памятника Turismo Roma: POINT (12.492438 41.889373), у южной стороны; не центр всего археологического парка.",
  },
  {
    id: "saint-basils", kind: "saint-basils", nameRussian: "Храм Василия Блаженного",
    location: [37.62306, 55.7525],
    sourceUrl: "https://shm.ru/museum/hvb/",
    coordinateSourceUrl: "https://www.wikidata.org/wiki/Q129846#P625",
    coordinateNote: "Приближённый якорь из утверждения Wikidata P625: N55 45 9, E37 37 23.002. ГИМ подтверждает объект и адрес, но эти координаты не публикует.",
  },
  {
    id: "taj-mahal", kind: "taj-mahal", nameRussian: "Тадж-Махал",
    location: [78.04222, 27.17417],
    sourceUrl: "https://whc.unesco.org/en/list/252/",
    coordinateSourceUrl: "https://whc.unesco.org/en/list/252/maps/",
    coordinateNote: "Точка комплекса UNESCO 252: N27 10 27.012, E78 2 31.992. Это опорная точка территории, не геодезический центр купола.",
  },
  {
    id: "great-wall-badaling", kind: "great-wall", nameRussian: "Великая стена · Бадалин",
    location: [116.01667, 40.35],
    sourceUrl: "https://whc.unesco.org/en/list/438/",
    coordinateSourceUrl: "https://whc.unesco.org/en/list/438/maps/",
    coordinateNote: "Опорная точка конкретного участка UNESCO 438-001 Badaling: N40 21 0, E116 1 0; не точная позиция отдельной башни и не центр всей стены.",
  },
  {
    id: "statue-of-liberty", kind: "statue-of-liberty", nameRussian: "Статуя Свободы",
    location: [-74.04472, 40.68944],
    sourceUrl: "https://www.nps.gov/stli/index.htm",
    coordinateSourceUrl: "https://whc.unesco.org/en/list/307/maps/",
    coordinateNote: "Точка UNESCO 307 на острове Либерти: N40 41 22, W74 2 41; округлена. Не пристань Манхэттена и не остров Эллис.",
  },
  {
    id: "christ-redeemer", kind: "christ-redeemer", nameRussian: "Статуя Христа-Искупителя",
    location: [-43.2105, -22.9519],
    sourceUrl: "https://en.santuariocristoredentor.com.br/localizacao",
    coordinateSourceUrl: "https://en.santuariocristoredentor.com.br/localizacao",
    coordinateNote: "Карта на официальной странице святилища задаёт Corcovado/Cristo Redentor: longitude -43.2105, latitude -22.9519; обзорный якорь монумента.",
  },
  {
    id: "sydney-opera", kind: "sydney-opera", nameRussian: "Сиднейский оперный театр",
    location: [151.21528, -33.85667],
    sourceUrl: "https://whc.unesco.org/en/list/166/",
    coordinateSourceUrl: "https://whc.unesco.org/en/list/166/maps/",
    coordinateNote: "Точка UNESCO 166rev на Беннелонг-Пойнт: S33 51 24, E151 12 55; округлена.",
  },
];

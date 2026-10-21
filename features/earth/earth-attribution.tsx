import styles from "./earth-attribution.module.css";
import { earthSatelliteAttribution, isCanonicalEarthAttribution } from "./satellite-attribution";

type Props = { satelliteAttribution?: string | null; walkingRoute?: boolean };

const walkingCredits = <>
  <a href="https://routing.openstreetmap.de/about.html" target="_blank" rel="noopener noreferrer">Пешком: FOSSGIS / OSRM</a>
  <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noopener noreferrer">Исправить карту</a>
</>;

/** Required data credits stay visible; the About panel contains licence details. */
export function EarthAttribution({ satelliteAttribution = null, walkingRoute = false }: Props = {}) {
  if (satelliteAttribution?.trim()) {
    const providers = earthSatelliteAttribution(satelliteAttribution).filter(part => !isCanonicalEarthAttribution(part));
    return <p className={`${styles.credits} ${styles.satellite}`} data-earth-attribution data-satellite>
      <a className={styles.logo} href="https://www.maptiler.com" target="_blank" rel="noopener noreferrer" aria-label="MapTiler">
        {/* The provider logo is requested only for the explicitly enabled raster. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="https://api.maptiler.com/resources/logo.svg" alt="MapTiler logo" width={67} height={20} decoding="async" referrerPolicy="no-referrer" />
      </a>
      <a href="https://www.maptiler.com/copyright/" target="_blank" rel="noopener noreferrer">© MapTiler</a>
      <span aria-hidden="true">·</span>
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap</a>
      <a href="https://openmaptiles.org/" target="_blank" rel="noopener noreferrer">OpenMapTiles</a>
      {providers.map((part, index) => part.href
        ? <a key={index} href={part.href} target="_blank" rel="noopener noreferrer">{part.text}</a>
        : <span key={index}>{part.text}</span>)}
      {walkingRoute && walkingCredits}
    </p>;
  }
  return <p className={styles.credits} data-earth-attribution>
    <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap</a>
    <span aria-hidden="true">·</span>
    <a href="https://openmaptiles.org/" target="_blank" rel="noopener noreferrer">OpenMapTiles</a>
    <span aria-hidden="true">·</span>
    <a href="/earth/models/CREDITS.txt" target="_blank" rel="noopener noreferrer">3D-модели</a>
    {walkingRoute && walkingCredits}
  </p>;
}

import styles from "./earth-attribution.module.css";

/** Required data credits stay visible; the About panel contains licence details. */
export function EarthAttribution() {
  return <p className={styles.credits} data-earth-attribution>
    <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap</a>
    <span aria-hidden="true">·</span>
    <a href="https://openmaptiles.org/" target="_blank" rel="noopener noreferrer">OpenMapTiles</a>
    <span aria-hidden="true">·</span>
    <a href="/earth/models/CREDITS.txt" target="_blank" rel="noopener noreferrer">3D-модели</a>
  </p>;
}

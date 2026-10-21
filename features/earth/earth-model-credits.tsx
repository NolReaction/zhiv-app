import { EARTH_MODEL_CREDITS } from "./model-credits";

export function EarthModelCredits() {
  return <div data-earth-model-credits>{EARTH_MODEL_CREDITS.map(model => <p key={model.id}>
    <a href={model.sourceUrl} target="_blank" rel="noopener noreferrer">{model.nameRussian} · {model.title}</a>{" — "}
    <a href={model.authorUrl} target="_blank" rel="noopener noreferrer">{model.author}</a>{" · "}
    <a href={model.licenseUrl} target="_blank" rel="noopener noreferrer">{model.license}</a>.
    {" "}{model.changes}
  </p>)}</div>;
}

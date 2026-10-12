import { FOREST_SPEECH_FONT } from "./forest-speech-painter";

const requests = new WeakMap<FontFaceSet, Promise<boolean>>();

/** Canvas alone does not request a CSS web font. Warm the local Cyrillic face
 * once per document; failure leaves the readable fallback and never blocks play. */
export function loadForestSpeechFont(fonts = typeof document === "undefined" ? undefined : document.fonts): Promise<boolean> {
  if (!fonts?.load) return Promise.resolve(false);
  const previous = requests.get(fonts);
  if (previous) return previous;
  const request = Promise.resolve().then(() => fonts.load(FOREST_SPEECH_FONT, "Мохлик Плёска Шишколап"))
    .then(faces => {
      if (!faces.length) { requests.delete(fonts); return false; }
      return true;
    }).catch(() => { requests.delete(fonts); return false; });
  requests.set(fonts, request);
  return request;
}

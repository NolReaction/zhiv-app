type CastAim = { voyage: string; cast: number; challenge: string | null; power: number };

/** One cosmetic draft per owner and tab. The authoritative cast id arrives after release. */
export function createBoatCastCheckpoint(owner: string, voyage: string) {
  const key = `zhiv.boat-cast.v1.${owner}`;
  let aim: CastAim | null = null;
  try {
    const value = JSON.parse(window.sessionStorage.getItem(key) ?? "null");
    if (value?.voyage === voyage && Number.isInteger(value.cast) && value.cast > 0
      && (value.challenge === null || typeof value.challenge === "string")
      && Number.isInteger(value.power) && value.power >= 15 && value.power <= 100) aim = value;
  } catch { /* A blocked storage or older draft leaves the default scene playable. */ }
  const save = (next: CastAim) => {
    aim = next;
    try { window.sessionStorage.setItem(key, JSON.stringify(next)); } catch { /* Keep the in-memory aim. */ }
  };
  return {
    release(cast: number, power: number) { save({ voyage, cast, challenge: null, power }); },
    confirm(cast: number, challenge?: string) {
      if (challenge && aim?.cast === cast && aim.challenge === null) save({ ...aim, challenge });
    },
    power(cast: number, challenge?: string) {
      return challenge && aim?.cast === cast && (!aim.challenge || aim.challenge === challenge) ? aim.power : 100;
    },
  };
}

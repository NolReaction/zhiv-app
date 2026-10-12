import type { EconomyCatalog, EconomyJob, EconomyRareDropClock } from "./model";

type Spec = NonNullable<EconomyCatalog["rareDrops"]>;
type Delivery = NonNullable<EconomyJob["rareDrop"]>;
export type RareRandomInteger = (exclusiveMaximum: number) => number;

/** Only the authenticated server transition uses this entropy; request IDs never seed rewards. */
export const secureRareInteger: RareRandomInteger = maximum => {
  const ceiling = Math.floor(0x1_0000_0000 / maximum) * maximum;
  const values = new Uint32Array(1);
  do { crypto.getRandomValues(values); } while (values[0] >= ceiling);
  return values[0] % maximum;
};

function draw(spec: Spec, random: RareRandomInteger): EconomyRareDropClock {
  const interval = random(spec.maxSeconds - spec.minSeconds + 1), item = random(spec.itemIds.length);
  if (!Number.isSafeInteger(interval) || interval < 0 || interval > spec.maxSeconds - spec.minSeconds
    || !Number.isInteger(item) || item < 0 || item >= spec.itemIds.length) throw new Error("Invalid trusted rare-material draw");
  return { version: 1, remainingSeconds: spec.minSeconds + interval, itemId: spec.itemIds[item] };
}

/** Starting/cancelling may reveal an outcome, but never moves the private completed-work clock. */
export function prepareRareDrop(current: EconomyRareDropClock | null | undefined, seconds: number, spec: Spec,
  random: RareRandomInteger = secureRareInteger) {
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds >= spec.minSeconds) throw new Error("Rare-material job exceeds one interval");
  const clock = current ?? draw(spec, random);
  if (clock.version !== 1 || !Number.isSafeInteger(clock.remainingSeconds) || clock.remainingSeconds <= 0
    || clock.remainingSeconds > spec.maxSeconds || !spec.itemIds.includes(clock.itemId)) throw new Error("Invalid rare-material clock");
  const itemId = clock.remainingSeconds <= seconds ? clock.itemId : null;
  return { clock, delivery: { version: 1 as const, seconds, itemId }, rewards: itemId ? { [itemId]: 1 } : {} };
}

/** Called after a successful claim's capacity checks. Carry excess work into the next interval. */
export function settleRareDrop(current: EconomyRareDropClock | null | undefined, delivery: Delivery, spec: Spec,
  random: RareRandomInteger = secureRareInteger): EconomyRareDropClock {
  if (!current || delivery.version !== 1) throw new Error("Missing saved rare-material clock");
  const expected = prepareRareDrop(current, delivery.seconds, spec, random);
  if (expected.delivery.itemId !== delivery.itemId) throw new Error("Rare-material delivery does not match its clock");
  const remaining = current.remainingSeconds - delivery.seconds;
  if (remaining > 0) return { ...current, remainingSeconds: remaining };
  const next = draw(spec, random);
  return { ...next, remainingSeconds: next.remainingSeconds + remaining };
}

/** Merging cannot select a closer roll or reset an existing clock. Equal clocks keep the target's type. */
export function mergeRareDropClocks(first?: EconomyRareDropClock | null, second?: EconomyRareDropClock | null) {
  return first && second ? first.remainingSeconds >= second.remainingSeconds ? first : second : first ?? second ?? null;
}

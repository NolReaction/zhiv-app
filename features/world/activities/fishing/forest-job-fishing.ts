import type { EconomySceneJourney } from "@/features/world/state/economy/economy-scene-state";
import { FISH_SPECIES_IDS, type FishSpeciesId } from "./fish-species";
import type { fishingActionFrame } from "./forest-fishing";

type CatchSlot = { at: number; species: FishSpeciesId };
export type ForestJobFishingPlan = { duration: number; catches: readonly CatchSlot[]; unit: number };
type Frame = ReturnType<typeof fishingActionFrame>;
const stages = [["bite",1.3],["reel",2.8],["catch",2.4],["pack",2.2]] as const;
const handlingSeconds = stages.reduce((sum,[,seconds])=>sum+seconds,0);

/** A finite projection of confirmed fish rewards. This never rolls a species,
 * creates an item, repeats a catch, or writes to the economic job. */
export function forestJobFishingPlan(job: EconomySceneJourney): ForestJobFishingPlan {
  const duration=Math.max(0,(Date.parse(job.finishesAt)-Date.parse(job.startedAt))/1000);
  const species: FishSpeciesId[]=[];
  // Metadata's one improved catch goes first only if it really exists in rewards.
  const ids=[...new Set([job.fishing?.fishId,...FISH_SPECIES_IDS])];
  for (const id of ids) {
    if (!id || !(FISH_SPECIES_IDS as readonly string[]).includes(id)) continue;
    const count=job.rewards?.[id];
    if (!Number.isSafeInteger(count) || count!<=0) continue;
    for(let index=0; index<count! && species.length<1000;index++) species.push(id as FishSpeciesId);
  }
  const finiteDuration=Number.isFinite(duration) ? duration : 0;
  const unit=Math.min(1,finiteDuration/Math.max(1,species.length)/16);
  return { duration:finiteDuration, unit,
    catches:finiteDuration>0 ? species.map((itemSpecies,index)=>({species:itemSpecies,at:finiteDuration*(index+1)/species.length-.5*unit})) : [] };
}

/** Server time chooses the catch window. The waiting pose can breathe forever,
 * but no short cosmetic loop is allowed to invent another visible fish. */
export function forestJobFishingFrame(plan: ForestJobFishingPlan, age: number, beganAge: number, still=false): Frame {
  const time=Math.max(0,Number.isFinite(age) ? age : 0), packed=plan.catches.filter(slot=>time>=slot.at);
  const basketSpecies=packed.at(-1)?.species;
  const slotIndex=plan.catches.findIndex(slot=>time<slot.at);
  const slot=slotIndex<0 ? undefined : plan.catches[slotIndex];
  const common={castIndex:Math.max(0,slotIndex<0 ? plan.catches.length : slotIndex),
    carryingFish:packed.length>0,basketFilled:packed.length>0,basketSpecies,
    outcome:"small" as const,catchScale:.95,species:slot?.species ?? basketSpecies ?? "fish" as FishSpeciesId};
  if(still) return {...common,action:"fish",phase:.3,frame:0,variation:"calm"};
  if(slot && time>=slot.at-handlingSeconds*plan.unit) {
    let start=slot.at-handlingSeconds*plan.unit;
    for(const [action,seconds] of stages) {
      const end=start+seconds*plan.unit;
      if(time<end) return {...common,action,phase:(time-start)/(seconds*plan.unit),frame:Math.floor((time-start)*4)%4,
        carryingFish:action==="catch" || action==="pack" || common.carryingFish,
        variation:action==="bite" ? "nibble" : "calm"};
      start=end;
    }
  }
  const last=packed.at(-1), resting=last && time<last.at+3.5*plan.unit;
  if(resting) return {...common,action:"rest",phase:(time-last.at)/(3.5*plan.unit),frame:0,variation:"calm"};
  const castStart=last ? last.at+3.5*plan.unit : beganAge;
  const local=time-castStart;
  if(local>=0 && local<1.4) return {...common,action:"idle",phase:local/1.4,frame:0,variation:"check"};
  if(local>=1.4 && local<3.2) return {...common,action:"cast",phase:(local-1.4)/1.8,frame:Math.floor((local-1.4)*4)%4,variation:"calm"};
  // Mild line checking has no bite/reel/held-fish implication.
  return {...common,action:"fish",phase:(time%7)/7,frame:Math.floor(time*4)%4,variation:"calm"};
}

/** Finish only a fish already hooked when the real job ends or is cancelled. */
export function forestJobFishingCleanup(plan: ForestJobFishingPlan, age: number): number | undefined {
  const slot=plan.catches.find(slot=>age<slot.at);
  if(!slot) return;
  const start=slot.at-handlingSeconds*plan.unit;
  return age>=start+1.3*plan.unit+2.8*plan.unit*.42 ? slot.at : undefined;
}

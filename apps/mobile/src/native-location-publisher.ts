import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { z } from "zod";
import { earthSharingSettingsSchema, type EarthSharingSettings } from "@/lib/earth-sharing-contract";
import {
  installNativeEarthPublisherFactory, installBackgroundLocationChoice, updateBackgroundLocationChoice,
  type NativeEarthPublication,
} from "@/features/earth/native-publisher";
import { NativeBridge } from "./native-bridge";

const snapshotSchema = z.object({
  active: z.boolean(), backgroundEnabled: z.boolean(), ownerPublicId: z.string().nullable(), epoch: z.string().nullable(),
  lastPublishedAt: z.string().nullable(), error: z.string().nullable(), sessionLost: z.boolean().optional(),
});
type Snapshot = z.infer<typeof snapshotSchema>;
interface LocationPlugin {
  getState(): Promise<Snapshot>;
  setBackgroundEnabled(options: { enabled: boolean }): Promise<Snapshot>;
  adopt(options: { settings: EarthSharingSettings; allowPermissionPrompt: boolean }): Promise<void>;
  stop(options: { ownerPublicId: string; epoch: string }): Promise<void>;
  addListener(event: "stateChange", listener: (state: Snapshot) => void): Promise<PluginListenerHandle>;
}
const Location = registerPlugin<LocationPlugin>("MochlikLocation");
let installed = false;
let installing: Promise<void> | null = null;

export function installNativeLocationPublisher(): Promise<void> {
  if (installed || !Capacitor.isNativePlatform()) return Promise.resolve();
  if (installing) return installing;
  installing = initialize().catch(error => { installing = null; throw error; });
  return installing;
}

async function initialize(): Promise<void> {
  if (!Capacitor.isPluginAvailable("MochlikLocation")) throw new Error("Пересоберите приложение: модуль передачи геопозиции не подключён");
  const empty: Snapshot = { active: false, backgroundEnabled: false, ownerPublicId: null, epoch: null, lastPublishedAt: null, error: null };
  let snapshot = empty, sessionRevision = 0, stateRevision = 0, choiceRequest = 0;
  let choiceBusy = false, choiceError: string | null = null;
  const listeners = new Set<(state: Snapshot) => void>();
  const publishChoice = () => updateBackgroundLocationChoice({ available: true, enabled: snapshot.backgroundEnabled, busy: choiceBusy, error: choiceError });
  const apply = (value: Snapshot) => {
    snapshot = snapshotSchema.parse(value);
    stateRevision++;
    publishChoice();
    for (const listener of listeners) listener(snapshot);
  };
  const readState = async () => {
    const session = sessionRevision, revision = stateRevision;
    const value = await Location.getState();
    if (session === sessionRevision && revision === stateRevision) apply(value);
  };
  const handles: PluginListenerHandle[] = [];
  try {
    handles.push(await Location.addListener("stateChange", apply));
    handles.push(await NativeBridge.addListener("sessionChange", () => {
      sessionRevision++; choiceRequest++; choiceBusy = false; choiceError = null;
      apply(empty);
      void readState().catch(() => {});
    }));
    await readState();
  } catch (error) {
    await Promise.allSettled(handles.map(handle => handle.remove()));
    throw error;
  }
  installBackgroundLocationChoice(async enabled => {
    if (choiceBusy) return;
    const request = ++choiceRequest, session = sessionRevision;
    const current = () => request === choiceRequest && session === sessionRevision;
    choiceBusy = true; choiceError = null; publishChoice();
    try {
      const value = await Location.setBackgroundEnabled({ enabled });
      if (current()) apply(value);
    }
    catch {
      if (current()) choiceError = enabled
        ? "Сначала разрешите геопозицию и проверьте поиск. Затем повторите включение фоновой передачи."
        : "Не удалось отключить фоновую передачу. Повторите попытку.";
    }
    finally { if (current()) { choiceBusy = false; publishChoice(); } }
  });
  installNativeEarthPublisherFactory(owner => {
    let epoch: string | null = null;
    return {
      async adopt(settings, options) {
        const checked = earthSharingSettingsSchema.parse(settings);
        if (checked.ownerPublicId !== owner || !checked.publicationEpoch) throw new Error("Неверный владелец геопозиции");
        epoch = checked.publicationEpoch;
        await Location.adopt({ settings: checked, allowPermissionPrompt: options.requestPermission });
      },
      stop() {
        const stopped = epoch; epoch = null;
        if (stopped) void Location.stop({ ownerPublicId: owner, epoch: stopped }).catch(() => {});
      },
      canContinueInBackground: () => snapshot.backgroundEnabled,
      subscribe(listener: (value: NativeEarthPublication) => void) {
        const receive = (value: Snapshot) => {
          if (value.ownerPublicId === owner || value.ownerPublicId === null) listener(value);
        };
        listeners.add(receive);
        return () => { listeners.delete(receive); };
      },
    };
  });
  installed = true;
}

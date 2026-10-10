import type Phaser from "phaser";
import { pixelSprite, pixelSpriteContact, type PixelDirection, type PixelPose } from "@/features/mochlik/pixel-sprite";
import type { FixedSite, FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";
import { createPhaserActorNavigation } from "./actor-navigation";

export type PhaserActorOptions = { reducedMotion?: boolean; shadows?: boolean };
type ActorFrame = { name: string; sole: number };
const DIRECTIONS: PixelDirection[] = ["front", "back", "left", "right"];
const POSES: PixelPose[] = ["idle", "walk", "blink"];
let nextTextureId = 0;

/** Cache the existing rig in one small atlas; frame changes never repaint or
 * upload a canvas. Each pose keeps its actual sole on the world ground point. */
function createActorAtlas(scene: Phaser.Scene) {
  const key = `phaser-mochlik-${++nextTextureId}`;
  const canvas = document.createElement("canvas");
  canvas.width = 48 * 4;
  canvas.height = 48 * DIRECTIONS.length * POSES.length;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Не удалось подготовить изображение Мохлика.");
  const frames = new Map<string, ActorFrame>();
  for (let poseIndex = 0; poseIndex < POSES.length; poseIndex++) {
    for (let directionIndex = 0; directionIndex < DIRECTIONS.length; directionIndex++) {
      for (let frame = 0; frame < 4; frame++) {
        const pose = POSES[poseIndex], direction = DIRECTIONS[directionIndex];
        const source = pixelSprite(pose, direction, frame);
        const name = `${pose}:${direction}:${frame}`;
        context.drawImage(source, frame * 48, (poseIndex * DIRECTIONS.length + directionIndex) * 48);
        frames.set(name, { name, sole: pixelSpriteContact(source)?.bottom ?? 45 });
      }
    }
  }
  const texture = scene.textures.addCanvas(key, canvas);
  if (!texture) throw new Error("Не удалось загрузить изображение Мохлика.");
  for (let poseIndex = 0; poseIndex < POSES.length; poseIndex++) {
    for (let directionIndex = 0; directionIndex < DIRECTIONS.length; directionIndex++) {
      for (let frame = 0; frame < 4; frame++) {
        texture.add(`${POSES[poseIndex]}:${DIRECTIONS[directionIndex]}:${frame}`, 0,
          frame * 48, (poseIndex * DIRECTIONS.length + directionIndex) * 48, 48, 48);
      }
    }
  }
  // Phaser.Textures.FilterMode.NEAREST = 1. Keep Phaser a type-only import so
  // the actor module itself remains safe for isolated non-browser tests.
  texture.setFilter(1);
  return { key, frames };
}

export function createPhaserActor(scene: Phaser.Scene, initialWorld: FixedWorldScene, initialOptions: PhaserActorOptions = {}) {
  const navigation = createPhaserActorNavigation(initialWorld);
  const atlas = createActorAtlas(scene);
  let world = initialWorld;
  let options = { reducedMotion: false, shadows: true, ...initialOptions };
  let direction: PixelDirection = "front";
  let animationTime = 0;
  let disposed = false;
  const shadow = scene.add.ellipse(0, 0, 1, 1, 0x172015, .22).setDepth(-9);
  const image = scene.add.image(0, 0, atlas.key, "idle:front:0");
  image.setName("phaser-mochlik");

  const present = () => {
    const position = navigation.position, size = world.actor?.size ?? 50;
    const walking = navigation.moving;
    const pose = walking ? "walk" : !options.reducedMotion && animationTime % 4_200 > 4_020 ? "blink" : "idle";
    const frame = options.reducedMotion ? 0 : Math.floor(animationTime / (walking ? 135 : 600)) % 4;
    const sprite = atlas.frames.get(`${pose}:${direction}:${frame}`)!;
    image.setFrame(sprite.name).setOrigin(.5, sprite.sole / 48).setDisplaySize(size, size)
      .setPosition(position.x, position.y).setDepth(position.y + .1).setVisible(navigation.active);
    shadow.setPosition(position.x, position.y - size * .015).setDisplaySize(size * .56, size * .17)
      .setVisible(navigation.active && options.shadows);
  };
  present();

  return {
    get position(): WorldPoint { return navigation.position; },
    get moving() { return navigation.moving; },
    update(_time: number, delta: number) {
      if (disposed) return;
      const step = navigation.update(delta);
      if (Math.hypot(step.x, step.y) > 1e-5) {
        direction = Math.abs(step.x) > Math.abs(step.y) ? step.x < 0 ? "left" : "right" : step.y < 0 ? "back" : "front";
      }
      animationTime += Math.min(50, Math.max(0, Number.isFinite(delta) ? delta : 0));
      present();
    },
    walkTo(point: WorldPoint): boolean { return !disposed && navigation.walkTo(point); },
    walkToSite(site: FixedSite) { return disposed ? null : navigation.walkToSite(site); },
    updateWorld(next: FixedWorldScene) {
      if (disposed) return;
      world = next;
      navigation.updateWorld(next);
      present();
    },
    updateOptions(patch: PhaserActorOptions) {
      if (disposed) return;
      options = { ...options, ...patch };
      present();
    },
    reset() {
      if (disposed) return;
      navigation.reset();
      direction = "front";
      animationTime = 0;
      present();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      navigation.stop();
      image.destroy();
      shadow.destroy();
      scene.textures.remove(atlas.key);
    },
  };
}

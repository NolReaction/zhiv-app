"use client";
import { useEffect, useRef } from "react";
import type { GameItemId } from "@/features/game/game-rewards";
import { drawOwnedDecor } from "@/features/mochlik/ambience";
import { HOME_DECOR } from "@/features/mochlik/home-layout";
import styles from "./world.module.css";

export function DecorationPreview({ item }: { item: GameItemId }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    const point = item === "leaf_garland" ? { x: (HOME_DECOR.garland.left.x + HOME_DECOR.garland.right.x) / 2 + 2, y: HOME_DECOR.garland.left.y + 14 }
      : item === "flower" ? HOME_DECOR.flower : item === "leaf_bed" ? { ...HOME_DECOR.bed, y: HOME_DECOR.bed.y + 10 } : HOME_DECOR.keepsakes;
    ctx.clearRect(0, 0, 144, 144); ctx.save(); ctx.scale(3, 3);
    ctx.translate(24 - point.x, 36 - point.y);
    drawOwnedDecor(ctx, [item]); ctx.restore();
  }, [item]);
  return <canvas className={styles.decorationPreview} ref={canvas} width={144} height={144} aria-hidden="true" />;
}

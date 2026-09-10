import { z } from "zod";

export const TAG_COLORS = {
  red: { label: "Красный", value: "#fb8b8b" }, orange: { label: "Оранжевый", value: "#ffb477" },
  yellow: { label: "Жёлтый", value: "#e8d681" }, green: { label: "Зелёный", value: "#a8d68d" },
  blue: { label: "Синий", value: "#8fc2ff" }, purple: { label: "Фиолетовый", value: "#c7a1ff" },
  pink: { label: "Розовый", value: "#f2a1d1" }, white: { label: "Белый", value: "#efefed" },
} as const;
export const playerTagSchema = z.object({
  text: z.string().regex(/^[A-Za-zА-Яа-яЁё0-9_-]{1,16}$/),
  color: z.enum(["red", "orange", "yellow", "green", "blue", "purple", "pink", "white"]),
});
export type PlayerTag = z.infer<typeof playerTagSchema>;

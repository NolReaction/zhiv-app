"use client";

import type { ComponentProps } from "react";
import { Switch } from "@/components/ui/switch";
import styles from "./sharing-switch.module.css";

export function SharingSwitch({ className, ...props }: ComponentProps<typeof Switch>) {
  return <Switch {...props} className={`${className ?? ""} ${styles.switch}`} />;
}

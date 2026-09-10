"use client";

import { FlaskConical } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import board from "@/features/game/game-leaderboard.module.css";
import styles from "./check-in-app.module.css";

export function BetaInfo() {
  return <Dialog>
    <DialogTrigger asChild><button type="button" className={styles.betaBadge}>beta-test</button></DialogTrigger>
    <DialogContent className={board.dialog}>
      <DialogHeader><DialogTitle className={board.title}><FlaskConical size={23} />Beta-тест</DialogTitle>
        <DialogDescription className={styles.betaDescription}>
          Приложение в beta-тесте и идёт активная разработка. Если вы обнаружите баги или захотите предложить идеи, свяжитесь со мной: <a href="mailto:66SH66SH@mail.ru">66SH66SH@mail.ru</a>
        </DialogDescription>
      </DialogHeader>
    </DialogContent>
  </Dialog>;
}

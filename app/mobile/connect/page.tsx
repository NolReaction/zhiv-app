import type { Metadata } from "next";
import { MobileConnect } from "@/features/account/mobile-connect";

export const metadata: Metadata = { title: "Вход в приложение · Мохлик", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default function MobileConnectPage() { return <MobileConnect />; }

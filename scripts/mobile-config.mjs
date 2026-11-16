import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const mode = process.env.NODE_ENV === "development" ? "development" : "production";
const env = { ...loadEnv(mode, root, "VITE_MOBILE_"), ...process.env };
const url = new URL(env.VITE_MOBILE_API_ORIGIN || "https://im-alive.ru");
if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
  throw new Error("VITE_MOBILE_API_ORIGIN must be a bare HTTPS origin");
}
const origin = url.origin;
const plistPath = new URL("../apps/mobile/ios/App/App/Info.plist", import.meta.url);
const plist = await readFile(plistPath, "utf8");
const key = /(<key>MobileBackendOrigin<\/key>\s*<string>)[^<]*(<\/string>)/;
if (!key.test(plist)) throw new Error("iOS MobileBackendOrigin is not configured");
await writeFile(plistPath, plist.replace(key, `$1${origin}$2`));
const androidPath = new URL("../apps/mobile/android/app/src/main/res/values/mobile_backend.xml", import.meta.url);
await writeFile(androidPath, `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <string name="mobile_backend_origin" translatable="false">${origin}</string>\n</resources>\n`);
console.log("[mobile] Native backend origin prepared for this build.");

import { randomBytes } from "node:crypto";
import { mkdirSync, chmodSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../deploy/.secrets/auth/", import.meta.url));
mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700);
try {
  writeFileSync(`${directory}code_secret`, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o444, flag: "wx" });
  console.log("Auth code secret created. Its value is not printed.");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log("Existing auth code secret preserved.");
}

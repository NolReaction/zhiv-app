import { randomBytes } from "node:crypto";
import { mkdirSync, chmodSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../deploy/.secrets/auth/", import.meta.url));
const parentDirectory = fileURLToPath(new URL("../deploy/.secrets/", import.meta.url));
mkdirSync(parentDirectory, { recursive: true, mode: 0o700 });
chmodSync(parentDirectory, 0o700);
mkdirSync(directory, { recursive: true, mode: 0o755 });
// The host parent is private; the bind-mounted child must be traversable by the API UID.
chmodSync(directory, 0o755);
try {
  writeFileSync(`${directory}code_secret`, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o444, flag: "wx" });
  console.log("Auth code secret created. Its value is not printed.");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log("Existing auth code secret preserved.");
}

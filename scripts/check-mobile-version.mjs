import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");
const [manifestText, lockText, android, ios, entry, capacitor] = await Promise.all([
  read("apps/mobile/package.json"), read("package-lock.json"),
  read("apps/mobile/android/app/build.gradle"), read("apps/mobile/ios/App/App.xcodeproj/project.pbxproj"),
  read("apps/mobile/src/main.tsx"), read("apps/mobile/capacitor.config.ts"),
]);
const version = JSON.parse(manifestText).version;
assert.match(version, /^\d+\.\d+\.\d+$/, "Mobile version must be major.minor.patch");
assert.equal(JSON.parse(lockText).packages["apps/mobile"].version, version, "Update the mobile workspace lockfile version");

const values = (text, expression, label) => {
  const found = [...text.matchAll(expression)].map(match => match[1]);
  assert.ok(found.length, `Missing ${label}`);
  return found;
};
for (const value of values(android, /\bversionName\s+["']([^"']+)["']/g, "Android versionName"))
  assert.equal(value, version, "Android and JavaScript versions must match");
for (const value of values(ios, /\bMARKETING_VERSION\s*=\s*([^;\s]+)\s*;/g, "iOS MARKETING_VERSION"))
  assert.equal(value, version, "iOS and JavaScript versions must match in every build configuration");
for (const value of values(entry, /\bappVersion:\s*["']([^"']+)["']/g, "client appVersion"))
  assert.equal(value, version, "Displayed client version must match the installed package");

const build = values(android, /\bversionCode\s+(\d+)/g, "Android versionCode")[0];
assert.ok(Number.isSafeInteger(Number(build)) && Number(build) > 0, "Build number must be a positive integer");
for (const value of values(ios, /\bCURRENT_PROJECT_VERSION\s*=\s*([^;\s]+)\s*;/g, "iOS CURRENT_PROJECT_VERSION"))
  assert.equal(value, build, "iOS and Android build numbers must match");

const appId = values(capacitor, /\bappId:\s*["']([^"']+)["']/g, "Capacitor appId")[0];
for (const value of values(android, /\bapplicationId\s+["']([^"']+)["']/g, "Android applicationId"))
  assert.equal(value, appId, "Android applicationId must match Capacitor");
for (const value of values(ios, /\bPRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;\s]+)\s*;/g, "iOS bundle identifier"))
  assert.equal(value, appId, "iOS bundle identifier must match Capacitor");

console.log(`Mobile package verified: ${appId}, version ${version}, build ${build}`);

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(execFileSync("python3", ["-B", "-c",
  "import json,plistlib,sys; print(json.dumps(plistlib.load(open(sys.argv[1], 'rb'))))",
  "apps/mobile/ios/App/App/PrivacyInfo.xcprivacy"], { cwd: root, encoding: "utf8" }));
const types = new Map(manifest.NSPrivacyCollectedDataTypes.map(item => [item.NSPrivacyCollectedDataType, item]));

test("authenticated game and opt-in location no longer ship the lab's empty collection declaration", () => {
  const functionality = "NSPrivacyCollectedDataTypePurposeAppFunctionality";
  const analytics = "NSPrivacyCollectedDataTypePurposeAnalytics";
  assert.equal(types.size, manifest.NSPrivacyCollectedDataTypes.length, "categories must not repeat");
  for (const name of ["Name", "EmailAddress", "UserID", "Contacts", "PreciseLocation", "CoarseLocation",
    "GameplayContent", "OtherUserContent", "ProductInteraction", "CustomerSupport", "OtherDiagnosticData"]) {
    const declaration = types.get(`NSPrivacyCollectedDataType${name}`);
    assert.ok(declaration, name);
    assert.equal(declaration.NSPrivacyCollectedDataTypeLinked, true, `${name} is account-linked`);
    assert.equal(declaration.NSPrivacyCollectedDataTypeTracking, false);
    assert.ok(declaration.NSPrivacyCollectedDataTypePurposes.includes(functionality));
  }
  for (const name of ["Name", "UserID", "GameplayContent", "ProductInteraction"])
    assert.ok(types.get(`NSPrivacyCollectedDataType${name}`).NSPrivacyCollectedDataTypePurposes.includes(analytics), `${name} has existing server analytics`);
  assert.equal(manifest.NSPrivacyTracking, false);
  assert.deepEqual(manifest.NSPrivacyTrackingDomains, []);
});

test("custom native clock and preferences APIs have the matching required-reason declarations", () => {
  const publisher = readFileSync(new URL("../apps/mobile/ios/App/App/MobileLocationPublisher.swift", import.meta.url), "utf8");
  assert.match(publisher, /ProcessInfo\.processInfo\.systemUptime/);
  assert.match(publisher, /UserDefaults\.standard/);
  const reasons = new Map(manifest.NSPrivacyAccessedAPITypes.map(item => [item.NSPrivacyAccessedAPIType, item.NSPrivacyAccessedAPITypeReasons]));
  assert.ok(reasons.get("NSPrivacyAccessedAPICategorySystemBootTime")?.includes("35F9.1"));
  assert.ok(reasons.get("NSPrivacyAccessedAPICategoryUserDefaults")?.includes("CA92.1"));
});

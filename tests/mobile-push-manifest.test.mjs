import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const script = fileURLToPath(new URL("../scripts/check-mobile-push-manifest.py", import.meta.url));
const action = '<action android:name="com.google.firebase.MESSAGING_EVENT" />';
const own = `<service android:name="ru.zhiv.mochlik.lab.MochlikMessagingService" android:exported="false"><intent-filter>${action}</intent-filter></service>`;
const fallback = `<service android:name="com.google.firebase.messaging.FirebaseMessagingService" android:exported="false"><intent-filter android:priority="-500">${action}</intent-filter></service>`;
const manifest = (services, permissions = true) => `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="ru.zhiv.mochlik.lab">
${permissions ? '<uses-permission android:name="android.permission.INTERNET"/><uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>' : ''}
<application>${services}</application></manifest>`;
async function verify(contents, duplicate = false) {
  const build = await mkdtemp(path.join(tmpdir(), "mochlik-manifest-"));
  try {
    for (const directory of duplicate ? ["processDebugManifest", "unexpectedSecondManifest"] : ["processDebugManifest"]) {
      const location = path.join(build, "intermediates/merged_manifests/debug", directory);
      if (contents !== null) { await mkdir(location, { recursive: true }); await writeFile(path.join(location, "AndroidManifest.xml"), contents); }
    }
    const result = spawnSync("python3", [script, build], { encoding: "utf8" });
    if (result.error) throw result.error;
    return result;
  } finally { await rm(build, { recursive: true, force: true }); }
}
test("merged manifest permits our sole receiver with the SDK low-priority fallback", async () => {
  for (const services of [own, own + fallback, own.replace('ru.zhiv.mochlik.lab.MochlikMessagingService', '.MochlikMessagingService') + fallback]) {
    const result = await verify(manifest(services));
    assert.equal(result.status, 0, result.stderr);
  }
});
test("merged manifest rejects plugin races, unexpected receivers, priority changes and exported handlers", async () => {
  for (const services of [
    own + own,
    own + '<service android:name="com.capacitorjs.plugins.pushnotifications.MessagingService" android:exported="false" />',
    own + fallback.replace('com.google.firebase.messaging.FirebaseMessagingService', 'other.Receiver'),
    own + fallback.replace('-500', '0'),
    own.replace('android:exported="false"', 'android:exported="true"'),
    own.replace(' android:exported="false"', ''),
    own.replace('<intent-filter>', '<intent-filter android:priority="1">'),
    fallback,
  ]) assert.notEqual((await verify(manifest(services))).status, 0, services);
});
test("merged manifest verification fails closed for missing permissions, absent or ambiguous artifacts", async () => {
  for (const [contents, duplicate] of [[manifest(own, false), false], [null, false], [manifest(own), true], ['<manifest>', false]]) {
    assert.notEqual((await verify(contents, duplicate)).status, 0);
  }
});

#!/usr/bin/env node
// Configure the existing VPS environment; never send, print or rotate VAPID keys.
import { createECDH, randomBytes } from "node:crypto";
import { chmodSync, chownSync, closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const keyNames = ["WEB_PUSH_VAPID_PUBLIC_KEY", "WEB_PUSH_VAPID_PRIVATE_KEY", "WEB_PUSH_VAPID_SUBJECT"];

function parseValue(raw, name) {
  const value = raw.trim();
  const quoted = value.match(/^(['"])(.*?)\1(\s*(?:#.*)?)$/);
  if (/^['"]/.test(value) && !quoted) throw new Error(`Invalid quoting for ${name}; existing configuration was preserved.`);
  const result = quoted ? quoted[2] : value.replace(/(?:^|\s+)#.*$/, "").trim();
  if (/[\r\n$\\]/.test(result)) throw new Error(`Use a literal value for ${name}; existing configuration was preserved.`);
  const comment = quoted ? quoted[3] : value.match(/(?:^|\s+)#.*$/)?.[0] ?? "";
  return { value: result, comment };
}

function validSubject(subject) {
  if (/[\s'"#$\\]/.test(subject)) return false;
  try {
    const url = new URL(subject);
    return (url.protocol === "mailto:" && url.pathname.includes("@"))
      || (url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password);
  } catch { return false; }
}

function validateKeys(publicKey, privateKey) {
  try {
    const decode = (value, length) => {
      if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) throw new Error();
      const bytes = Buffer.from(value, "base64url");
      if (bytes.length !== length || bytes.toString("base64url") !== value.replace(/=+$/, "")) throw new Error();
      return bytes;
    };
    const curve = createECDH("prime256v1");
    curve.setPrivateKey(decode(privateKey, 32));
    if (!curve.getPublicKey().equals(decode(publicKey, 65))) throw new Error();
  } catch { throw new Error("Existing VAPID keys are invalid or do not match; they were preserved."); }
}

function configure(path, requestedSubject) {
  const originalStat = lstatSync(path);
  if (!originalStat.isFile()) throw new Error("The environment must be a regular file, not a symlink.");
  const lockPath = `${path}.web-push.lock`;
  let lock;
  let temporary;
  try {
    try { lock = openSync(lockPath, "wx", 0o600); }
    catch (error) {
      if (error.code === "EEXIST") throw new Error("Web Push configuration is locked. Wait for the other setup to finish; inspect a stale .env.web-push.lock before removing it.");
      throw error;
    }
    const original = readFileSync(path, "utf8");
    const lines = original.split("\n");
    const settings = new Map();
    for (const [index, line] of lines.entries()) {
      const match = line.match(/^(\s*(?:export\s+)?(DOMAIN|WEB_PUSH_VAPID_PUBLIC_KEY|WEB_PUSH_VAPID_PRIVATE_KEY|WEB_PUSH_VAPID_SUBJECT)\s*=)(.*)$/);
      if (!match) continue;
      if (settings.has(match[2])) throw new Error(`Duplicate ${match[2]}; existing configuration was preserved.`);
      settings.set(match[2], { ...parseValue(match[3], match[2]), index, prefix: match[1] });
    }
    const current = keyNames.map(name => settings.get(name)?.value ?? "");
    const present = current.filter(Boolean).length;
    if (present !== 0 && present !== 3) throw new Error("Partial WEB_PUSH_VAPID configuration found. Complete or correct it manually; no keys were replaced.");
    if (present === 3) {
      validateKeys(current[0], current[1]);
      if (!validSubject(current[2])) throw new Error("Existing VAPID subject is invalid; configuration was preserved.");
      if (requestedSubject && requestedSubject !== current[2]) throw new Error("VAPID is already configured; --subject cannot replace its existing contact.");
      chmodSync(path, 0o600);
      console.log("Web Push is already configured. Existing keys and settings were preserved; secrets are not printed.");
      return;
    }
    let subject = requestedSubject;
    if (!subject) {
      const domain = settings.get("DOMAIN")?.value;
      if (!domain || !/^[a-zA-Z0-9.-]+(?::[0-9]+)?$/.test(domain)) throw new Error("Set a valid DOMAIN or pass --subject mailto:admin@example.com.");
      subject = `https://${domain}`;
    }
    if (!validSubject(subject)) throw new Error("Use --subject with a mailto contact or an HTTPS URL without credentials.");
    const curve = createECDH("prime256v1");
    curve.generateKeys();
    // OpenSSL may omit leading zeroes from the private scalar; VAPID needs 32 bytes.
    const privateBytes = curve.getPrivateKey();
    const privateKey = Buffer.concat([Buffer.alloc(32 - privateBytes.length), privateBytes]).toString("base64url");
    const values = [curve.getPublicKey().toString("base64url"), privateKey, subject];
    const newline = original.includes("\r\n") ? "\r\n" : "\n";
    const missing = [];
    keyNames.forEach((name, index) => {
      const setting = settings.get(name);
      if (setting) lines[setting.index] = `${setting.prefix}${values[index]}${setting.comment ? ` ${setting.comment.trimStart()}` : ""}${lines[setting.index].endsWith("\r") ? "\r" : ""}`;
      else missing.push(`${name}=${values[index]}`);
    });
    let updated = lines.join("\n");
    if (missing.length) updated += `${updated.endsWith("\n") ? "" : newline}${missing.join(newline)}${newline}`;
    temporary = `${path}.web-push-${randomBytes(12).toString("hex")}.tmp`;
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, updated);
      // Preserve the existing owner when setup is explicitly run as root.
      if (process.getuid?.() === 0) chownSync(temporary, originalStat.uid, originalStat.gid);
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    const currentStat = lstatSync(path);
    if (!currentStat.isFile() || currentStat.ino !== originalStat.ino || readFileSync(path, "utf8") !== original) {
      throw new Error("The environment changed during setup; no configuration was replaced. Run setup again.");
    }
    renameSync(temporary, path);
    temporary = undefined;
    console.log("Web Push configured in the environment file (0600). Recreate the API container to apply; secrets are not printed.");
  } finally {
    if (temporary) unlinkSync(temporary);
    if (lock !== undefined) { closeSync(lock); unlinkSync(lockPath); }
  }
}

try {
  const { values } = parseArgs({ options: { env: { type: "string", default: "deploy/.env" }, subject: { type: "string" }, help: { type: "boolean" } } });
  if (values.help) console.log("Usage: node scripts/configure-web-push.mjs [--env deploy/.env] [--subject mailto:admin@example.com]\nGenerates keys only when all three VAPID settings are empty; default subject is https://DOMAIN. Does not restart services.");
  else configure(resolve(values.env), values.subject);
} catch (error) {
  // Errors never include the contents of the environment or generated keys.
  console.error(`Web Push configuration not saved: ${error.message}`);
  process.exitCode = 1;
}

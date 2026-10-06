import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const BINARY_EXTENSION = /\.(?:png|jpe?g|webp|gif|ico|woff2?|ttf|otf|mp[34]|ogg|wav|pdf|zip|gz|jar)$/i;
const TOKEN_RULES = [
  ["private-key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{40,255})\b/g],
  ["openai-key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,256}\b/g],
  ["aws-access-id", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["google-key", /\bAIza[A-Za-z0-9_-]{35}\b/g],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{20,200}\b/g],
  ["stripe-secret", /\b(?:sk|rk)_live_[A-Za-z0-9]{16,200}\b/g],
  ["telegram-token", /\b\d{8,12}:[A-Za-z0-9_-]{35}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{20,}\b/g],
];
const CREDENTIAL_NAME = /(?:secret|password|passwd|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|signing[_-]?key|secret[_-]?access[_-]?key|secret[_-]?key|api[_-]?token|bearer[_-]?token|smtp[_-]?pass|authorization)(?:_value|Value)?$/i;
const QUOTED_ASSIGNMENT = /\b([A-Za-z_][\w-]{0,99})["']?\s*[:=]\s*(["'])([^"'\r\n]{1,512})\2/g;
const ENV_ASSIGNMENT = /^\s*([A-Z][A-Z_0-9]{0,99})\s*[:=]\s*([^\s"'#][^\r\n#]{0,511})/gm;
const CREDENTIAL_URL = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|https?):\/\/([^\s:@/"'`]+):([^\s@/"'`]+)@/g;

// Each exception is reviewed public fixture data, scoped to an exact file and value.
// Real provider token/private-key patterns are NEVER excepted by this list.
const FIXTURE_FINGERPRINTS = new Map(JSON.parse(readFileSync(new URL("./secret-scan-fixtures.json", import.meta.url), "utf8"))
  .map(({ file, sha256 }) => [file, new Set(sha256)]));
export function secretFingerprint(value) {
  return createHash("sha256").update(value).digest("hex");
}
function placeholder(value) {
  return /^\$\(\s*cat\s+\/run\/secrets\/[\w.-]+\s*\)$/.test(value) || /^(?:\$\{[^\r\n]+\}|\$[A-Z_][A-Z_0-9]*|<[^<>\r\n]+>|(?:replace|change)[-_]?me|your[-_](?:key|secret|token|password))$/i.test(value);
}
function excepted(file, value) {
  return FIXTURE_FINGERPRINTS.get(file)?.has(secretFingerprint(value)) ?? false;
}
function secretName(name) {
  return CREDENTIAL_NAME.test(name) && !/(?:_FILE|File|_PATH|Path|_NAME|Name|_LENGTH|Length|_BYTES|Bytes|_ENABLED|Enabled)$/u.test(name);
}
/** Returns metadata only. Never add values, source excerpts, or whole matches here. */
export function scanSecretText(file, text) {
  const findings = [];
  const seen = new Set();
  const add = (kind, value, offset) => {
    const line = text.slice(0, offset).split("\n").length;
    const fingerprint = secretFingerprint(value).slice(0, 12);
    const key = `${kind}:${line}:${fingerprint}`;
    if (!seen.has(key)) findings.push({ file, line, kind, fingerprint });
    seen.add(key);
  };
  for (const [kind, pattern] of TOKEN_RULES) {
    for (const match of text.matchAll(new RegExp(pattern))) add(kind, match[0], match.index);
  }
  for (const pattern of [QUOTED_ASSIGNMENT, ENV_ASSIGNMENT]) {
    for (const match of text.matchAll(new RegExp(pattern))) {
      if (!secretName(match[1])) continue;
      const value = (pattern === QUOTED_ASSIGNMENT ? match[3] : match[2]).trim();
      if (!value || placeholder(value) || excepted(file, value)) continue;
      // Unquoted source identifiers/expressions are not literal credentials. ENV names
      // are upper-case; interpolation must stand alone to qualify as a placeholder.
      if (pattern === ENV_ASSIGNMENT && /^(?:true|false|null|undefined|\d+)$/.test(value)) continue;
      add("credential-literal", value, match.index);
    }
  }
  for (const match of text.matchAll(new RegExp(CREDENTIAL_URL))) {
    if (placeholder(match[2]) || excepted(file, match[0])) continue;
    add("credential-url", match[0], match.index);
  }
  return findings;
}
function git(cwd, args, options = {}) {
  return execFileSync("git", args, { cwd, maxBuffer: 280 * 1024 * 1024, ...options });
}
function knownBinaryHeader(file, bytes) {
  if (!BINARY_EXTENSION.test(file)) return false;
  const ascii = bytes.toString("latin1");
  return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ||
    (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") ||
    /^(?:GIF8[79]a|wOF[2F]|OTTO|%PDF-|PK\x03\x04|OggS)/.test(ascii) ||
    (bytes[0] === 31 && bytes[1] === 139);
}
function fileHeader(file) {
  const descriptor = openSync(file, "r");
  try { const header = Buffer.alloc(16); return header.subarray(0, readSync(descriptor, header, 0, 16, 0)); }
  finally { closeSync(descriptor); }
}
function decodeText(bytes) {
  if (bytes.includes(0)) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return null; }
}
function inspect(counters, findings, file, bytes, object) {
  const text = decodeText(bytes);
  if (text === null) { counters.binary++; return; }
  counters.text++;
  for (const found of scanSecretText(file, text)) findings.push(object ? { ...found, object: object.slice(0, 12) } : found);
}
export function checkRepositorySecrets(cwd, { history = false } = {}) {
  const root = realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]).toString().trim());
  const counters = { text: 0, binary: 0, knownBinary: 0 };
  const findings = [];
  if (!history) {
    const files = git(root, ["ls-files", "-z"]).toString().split("\0").filter(Boolean);
    for (const file of files) {
      const absolute = path.resolve(root, file);
      // Do not follow a tracked symlink out of the repository into local credentials.
      const resolved = realpathSync(absolute);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error("Tracked symlink points outside repository");
      if (statSync(absolute).size > MAX_TEXT_BYTES) {
        if (knownBinaryHeader(file, fileHeader(absolute))) { counters.knownBinary++; continue; }
        throw new Error(`Text scan size limit: ${JSON.stringify(file)}`);
      }
      inspect(counters, findings, file, readFileSync(absolute));
    }
  } else {
    if (git(root, ["rev-parse", "--is-shallow-repository"]).toString().trim() === "true") throw new Error("History scan requires a non-shallow checkout");
    const names = new Map(git(root, ["rev-list", "--objects", "--all"]).toString().trim().split("\n").map((line) => {
      const split = line.indexOf(" ");
      return split < 0 ? [line, ""] : [line.slice(0, split), line.slice(split + 1)];
    }));
    const meta = git(root, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], { input: [...names.keys()].join("\n") + "\n" }).toString().trim().split("\n");
    const blobs = [];
    for (const item of meta) {
      const [object, type, size] = item.split(" ");
      if (type !== "blob") continue;
      const file = names.get(object);
      if (Number(size) > MAX_TEXT_BYTES) {
        if (BINARY_EXTENSION.test(file) && knownBinaryHeader(file, git(root, ["cat-file", "blob", object]).subarray(0, 16))) { counters.knownBinary++; continue; }
        throw new Error(`History text scan size limit: ${JSON.stringify(file)}`);
      }
      blobs.push({ object, file, size: Number(size) });
    }
    for (let start = 0; start < blobs.length; start += 64) {
      const batch = blobs.slice(start, start + 64);
      const bytes = git(root, ["cat-file", "--batch"], { input: batch.map(({ object }) => object).join("\n") + "\n" });
      let offset = 0;
      for (const { object, file, size } of batch) {
        const end = bytes.indexOf(10, offset);
        if (end < offset || bytes.subarray(offset, end).toString() !== `${object} blob ${size}` || bytes[end + 1 + size] !== 10) throw new Error("Incomplete Git blob response");
        inspect(counters, findings, file, bytes.subarray(end + 1, end + 1 + size), object);
        offset = end + size + 2;
      }
      if (offset !== bytes.length) throw new Error("Unexpected Git blob response");
    }
  }
  return { mode: history ? "reachable-history" : "tracked-working-tree", ...counters, findings };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== "--history")) throw new Error("Usage: node scripts/check-secrets.mjs [--history]");
    const result = checkRepositorySecrets(process.cwd(), { history: args.includes("--history") });
    for (const finding of result.findings) console.error(JSON.stringify(finding));
    console.log(JSON.stringify({ ...result, findings: result.findings.length }));
    process.exitCode = result.findings.length ? 1 : 0;
  } catch (error) {
    // Git stderr could include credential-shaped paths. Do not echo subprocess errors.
    console.error(error?.code ? "Secret scan could not read repository; no clean result." : error.message);
    process.exitCode = 2;
  }
}

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false },
});

const inviteImport = await vite.ssrLoadModule("/lib/invite-import.ts");
const token = "K_Px9NhbG9Y6vnUg3BDnv-o4m5GkSb9uLrv0ptuGSvU";

after(async () => {
  await vite.close();
});

test("imports a raw capability token", () => {
  assert.deepEqual(inviteImport.parseInviteToken(token), { ok: true, token });
});

test("imports an exact HTTP or HTTPS invitation URL", () => {
  for (const url of [
    `http://192.168.1.232:3000/#/invite/${token}`,
    `https://zhiv.example/#/invite/${token}`,
  ]) {
    assert.deepEqual(inviteImport.parseInviteToken(url), { ok: true, token });
  }
});

test("formats a display code without changing the token and round-trips it", () => {
  const code = inviteImport.inviteCode(token);

  assert.equal(code.replaceAll(" ", ""), token);
  assert.match(code, /^(?:[A-Za-z0-9_-]{4} ){10}[A-Za-z0-9_-]{3}$/);
  assert.deepEqual(inviteImport.parseInviteToken(code), { ok: true, token });
  assert.deepEqual(
    inviteImport.parseInviteToken(code.replaceAll(" ", "\n")),
    { ok: true, token },
  );
});

test("does not accept arbitrary whitespace inserted into a token", () => {
  const ambiguous = `${token.slice(0, 8)} ${token.slice(8)}`;
  assert.deepEqual(inviteImport.parseInviteToken(ambiguous), {
    ok: false,
    error: "Ссылка или код приглашения имеют неверный формат.",
  });
});

test("rejects recovery capabilities with a specific explanation", () => {
  for (const value of [
    `https://zhiv.example/#/recover/${token}`,
    `#/recover/${token}`,
    `/recover/${token}`,
  ]) {
    assert.deepEqual(inviteImport.parseInviteToken(value), {
      ok: false,
      error: "Это ссылка восстановления, а не приглашение.",
    });
  }
});

test("rejects foreign fragments, paths and query strings", () => {
  for (const value of [
    `https://zhiv.example/#/other/${token}`,
    `https://zhiv.example/#/invite/${token}/extra`,
    `https://zhiv.example/invite/#/invite/${token}`,
    `https://zhiv.example/?source=chat#/invite/${token}`,
    `#/invite/${token}`,
  ]) {
    assert.equal(inviteImport.parseInviteToken(value).ok, false);
  }
});

test("rejects credentials, non-web protocols and malformed input", () => {
  for (const value of [
    `https://user:password@zhiv.example/#/invite/${token}`,
    `ftp://zhiv.example/#/invite/${token}`,
    "javascript:alert(1)",
    "not an invite",
    "short-token",
  ]) {
    assert.deepEqual(inviteImport.parseInviteToken(value), {
      ok: false,
      error: "Ссылка или код приглашения имеют неверный формат.",
    });
  }
});

test("returns a useful empty-input error and rejects invalid display tokens", () => {
  assert.deepEqual(inviteImport.parseInviteToken("  \n "), {
    ok: false,
    error: "Вставьте ссылку или код приглашения.",
  });
  assert.throws(
    () => inviteImport.inviteCode("not-a-token"),
    /Некорректный токен приглашения/,
  );
});

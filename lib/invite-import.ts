import { isCapabilityToken } from "@/lib/capability-token";

export type InviteTokenParseResult =
  | { ok: true; token: string }
  | { ok: false; error: string };

export const INVITE_IMPORT_EVENT = "zhiv:invite-import";

const EMPTY_INVITE_ERROR = "Вставьте ссылку или код приглашения.";
const INVALID_INVITE_ERROR = "Ссылка или код приглашения имеют неверный формат.";
const RECOVERY_LINK_ERROR = "Это ссылка восстановления, а не приглашение.";
const CODE_GROUP_SIZE = 4;

function parseGroupedCode(input: string): string | null {
  const groups = input.split(/\s+/);
  const expectedGroupCount = Math.ceil(43 / CODE_GROUP_SIZE);
  if (groups.length !== expectedGroupCount) return null;

  const lastGroupLength = 43 % CODE_GROUP_SIZE || CODE_GROUP_SIZE;
  const hasCanonicalGrouping = groups.every((group, index) =>
    group.length === (index === groups.length - 1 ? lastGroupLength : CODE_GROUP_SIZE)
  );
  if (!hasCanonicalGrouping) return null;

  const token = groups.join("");
  return isCapabilityToken(token) ? token : null;
}

function parseInviteUrl(input: string): InviteTokenParseResult | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== ""
  ) {
    return { ok: false, error: INVALID_INVITE_ERROR };
  }

  const recoveryMatch = /^#\/recover\/([A-Za-z0-9_-]{43})$/.exec(url.hash);
  if (recoveryMatch && isCapabilityToken(recoveryMatch[1])) {
    return { ok: false, error: RECOVERY_LINK_ERROR };
  }

  const inviteMatch = /^#\/invite\/([A-Za-z0-9_-]{43})$/.exec(url.hash);
  if (!inviteMatch || !isCapabilityToken(inviteMatch[1])) {
    return { ok: false, error: INVALID_INVITE_ERROR };
  }

  return { ok: true, token: inviteMatch[1] };
}

export function parseInviteToken(input: string): InviteTokenParseResult {
  const value = input.trim();
  if (!value) return { ok: false, error: EMPTY_INVITE_ERROR };

  if (isCapabilityToken(value)) return { ok: true, token: value };

  const groupedToken = parseGroupedCode(value);
  if (groupedToken) return { ok: true, token: groupedToken };

  if (/^#?\/recover\//.test(value)) {
    return { ok: false, error: RECOVERY_LINK_ERROR };
  }

  return parseInviteUrl(value) ?? { ok: false, error: INVALID_INVITE_ERROR };
}

export function inviteCode(token: string): string {
  if (!isCapabilityToken(token)) {
    throw new TypeError("Некорректный токен приглашения");
  }

  return token.match(new RegExp(`.{1,${CODE_GROUP_SIZE}}`, "g"))!.join(" ");
}

// User text is data, never HTML or instructions. Reject invisible controls that
// can forge the visual order of names/messages; keep ordinary RTL and emoji.
// Keep in sync with identity/UserText.kt. This is for new writes, not migration.
const singleLineControls = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const multiLineControls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

export function hasUserTextControls(value: string, multiline = false): boolean {
  return (multiline ? multiLineControls : singleLineControls).test(value);
}

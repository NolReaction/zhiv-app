export type InviteMode = "link" | "qr";

export type InviteDialogState = {
  open: boolean;
  mode: InviteMode;
};

export type InviteDialogAction =
  | { type: "open"; mode: InviteMode }
  | { type: "close" };

export const initialInviteDialogState: InviteDialogState = {
  open: false,
  mode: "link",
};

export function inviteDialogReducer(
  state: InviteDialogState,
  action: InviteDialogAction,
): InviteDialogState {
  if (action.type === "open") {
    return { open: true, mode: action.mode };
  }

  if (!state.open) return state;

  // Radix keeps the dialog mounted while its exit animation runs. Preserve
  // the last mode so a closing QR dialog never flashes the link variant.
  return { ...state, open: false };
}

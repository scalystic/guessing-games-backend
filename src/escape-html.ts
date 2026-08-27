/// Shared by anywhere a user-controlled string (above all a player's display
/// name) gets interpolated into an HTML string that's later rendered via
/// dangerouslySetInnerHTML — chat system-message text, on both the server
/// (socket-handler.ts) and the client (RoomLobby's local "X joined" lines).
/// Plain-text values (rendered as React children) never need this; only ones
/// destined for dangerouslySetInnerHTML do.
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

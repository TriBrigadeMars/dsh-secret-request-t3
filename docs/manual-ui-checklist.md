# Manual UI checklist (dsh web UI)

Run these steps by hand in a real dsh web session. Automation covers the locale
keys, the built card tree, and the host/broker protocol; it cannot drive the
browser chat UI. The implementing agent cannot complete the web-UI steps in CI —
the orchestrator runs them before release.

1. Trigger a `request_secret` tool call with `delivery: 'secretRef'`,
   `url`, `placeholder`, and `expiresAt` about one minute in the future.
2. Confirm the card appears inline at the tool call in the conversation, not in
   a modal or a separate panel.
3. Confirm the input is single-line, masked (`type="password"`), and shows the
   request's placeholder text.
4. Confirm the "Open credential page" link opens `request.url` in a new tab and
   does not submit the form or trigger chat hotkeys.
5. Confirm the one-use note is shown for `secretRef`; repeat with
   `delivery: 'file'` and confirm the file note appears instead.
6. Confirm the remaining-time hint counts down and matches `expiresAt`.
7. Type a recognizable test value, press Save, and confirm the card shows
   `saved`; confirm the value is not present in the chat history, the DOM after
   submit, the tool result, or any log.
8. Repeat with Decline and confirm the card shows `declined`.
9. Repeat and leave the card untouched until the request expires; confirm the
   card shows `timed_out` together with the "send the request again" hint.
10. Confirm the request label is reachable as the card's hover title.

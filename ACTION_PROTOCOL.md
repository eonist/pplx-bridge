# pplx-bridge Action Protocol

Actions flow from the **viewer** (or Comet) → relay `/actions` → **extension** → injected into Chrome tab.

## Transport

- WebSocket: `ws://localhost:7001/actions`
- Messages: UTF-8 JSON
- Extension identifies itself on connect with `{ "register": "extension" }`
- All other senders are treated as action sources (viewer, Comet)

## Action schema

### click
Click at a normalised viewport position.
```json
{ "type": "click", "x": 0.5, "y": 0.3 }
```
- `x`, `y`: fraction of viewport width/height (0–1)

### mousemove
Move the mouse cursor to a position (triggers hover states, tooltips, dropdowns).
```json
{ "type": "mousemove", "x": 0.5, "y": 0.3 }
```

### type
Insert text into the currently focused element. Send one character at a time for incremental input, or a full string to set the entire value.
```json
{ "type": "type", "value": "a" }
{ "type": "type", "value": "hello world" }
```
- Works on `<input>`, `<textarea>`, and `contenteditable` elements
- React-compatible: uses native HTMLInputElement value setter

### keydown
Send a special key or key combination.
```json
{ "type": "keydown", "key": "Enter",     "code": "Enter",     "shiftKey": false, "ctrlKey": false, "metaKey": false }
{ "type": "keydown", "key": "Backspace",  "code": "Backspace",  "shiftKey": false, "ctrlKey": false, "metaKey": false }
{ "type": "keydown", "key": "Tab",        "code": "Tab",        "shiftKey": false, "ctrlKey": false, "metaKey": false }
{ "type": "keydown", "key": "ArrowDown",  "code": "ArrowDown",  "shiftKey": false, "ctrlKey": false, "metaKey": false }
{ "type": "keydown", "key": "Escape",     "code": "Escape",     "shiftKey": false, "ctrlKey": false, "metaKey": false }
```
- `key`: the [KeyboardEvent.key](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/key) value
- `code`: the [KeyboardEvent.code](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/code) value

### scroll
Scroll the page or focused scrollable element.
```json
{ "type": "scroll", "x": 0, "y": 120 }
```
- `x`, `y`: pixel delta (matches `WheelEvent.deltaX` / `deltaY`)

## Notes

- The viewer sends `type` for printable characters and `keydown` for special keys
- Comet can send any combination of the above to drive the browser
- Frame stream is separate: `ws://localhost:7001/stream` (binary JPEG, read-only from viewer perspective)

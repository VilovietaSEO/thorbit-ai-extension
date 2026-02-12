---
name: navigation
version: "1.0"
loadWhen: always
priority: 10
tokens: ~150
---

## Navigation Actions

**navigate** - Go to a URL
```json
{ "type": "navigate", "url": "https://google.com" }
```
Opens in current tab. Always follow with a wait.

**wait** - Wait for page to settle
```json
{ "type": "wait", "ms": 1000 }
```
Use after: navigation, clicks that trigger page changes, form submissions
Default: 500ms for minor actions, 1000-2000ms for page loads

**back** - Go back in browser history
```json
{ "type": "back" }
```

**refresh** - Reload current page
```json
{ "type": "refresh" }
```

Navigation tips:
- Always wait after navigate before interacting
- If page doesn't load expected content, try scrolling or waiting longer
- Check URL in page state to confirm navigation succeeded

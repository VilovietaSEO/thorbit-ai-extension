---
name: screenshot-analysis
version: "1.0"
loadWhen: context.hasScreenshot == true
priority: 15
tokens: ~300
---

## Screenshot Analysis

When DOM labels are insufficient, you receive a screenshot. Use visual analysis to:

**Identify unlabeled elements:**
- Buttons that look clickable but aren't in DOM (canvas, SVG, custom elements)
- Visual cues like icons, colors, positioning
- Text rendered as images

**Understand layout:**
- Where is the main content vs sidebar vs header?
- What section contains the target element?
- Are there modal dialogs or overlays blocking content?

**Detect state:**
- Is a form showing validation errors (red borders)?
- Is a button disabled (grayed out)?
- Is content loading (spinners, skeletons)?
- Are there popups or notifications?

**Coordinate with DOM:**
- Use screenshot to understand context
- Use DOM labels to execute actions
- If visual element has no DOM label, try clicking by coordinates (last resort)

**Coordinate-based click (when no label available):**
```json
{ "type": "click_coords", "x": 450, "y": 320 }
```
Only use when element is visible in screenshot but has no DOM label.

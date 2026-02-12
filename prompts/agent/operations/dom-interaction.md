---
name: dom-interaction
version: "1.0"
loadWhen: always
priority: 10
tokens: ~250
---

## DOM Interaction Actions

**click** - Click an element by label
```json
{ "type": "click", "label": 5 }
```
Use for: buttons, links, checkboxes, radio buttons, tabs, menu items

**type** - Enter text into an input
```json
{ "type": "type", "label": 3, "value": "hello world" }
```
Use for: text inputs, textareas, search boxes, content-editable fields
Note: This replaces existing content. For append, read first.

**scroll** - Scroll the page
```json
{ "type": "scroll", "direction": "down", "amount": 500 }
```
Directions: "up", "down". Amount in pixels.
Use when: target element not visible, need to load more content

**hover** - Hover over an element (triggers dropdowns)
```json
{ "type": "hover", "label": 7 }
```
Use for: dropdown menus, tooltips, hover-reveal content

**focus** - Focus an element without clicking
```json
{ "type": "focus", "label": 2 }
```
Use for: form fields that need focus before interaction

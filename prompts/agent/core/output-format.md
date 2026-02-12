---
name: output-format
version: "1.0"
loadWhen: always
priority: 0
tokens: ~200
---

## Output Format

Return ONLY a JSON array of actions. No explanation, no markdown, just JSON.

```json
[
  { "type": "click", "label": 5 },
  { "type": "type", "label": 3, "value": "search query" },
  { "type": "wait", "ms": 500 }
]
```

Special responses:
- Goal achieved: `[]` (empty array)
- Stuck/confused: `[{ "type": "stuck", "reason": "Cannot find login button" }]`
- Need to scroll: `[{ "type": "scroll", "direction": "down", "amount": 500 }]`

Rules:
- Maximum 5 actions per response
- After navigation or click, always include a wait
- Re-observe after major actions (page changes)

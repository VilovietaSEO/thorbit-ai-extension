---
name: observation
version: "1.0"
loadWhen: always
priority: 10
tokens: ~200
---

## Understanding Page State

You receive the page as a pruned DOM with labeled interactive elements:

```
[0] button - "Sign In"
[1] input - "" (placeholder: "Email")
[2] input - "" (placeholder: "Password")
[3] button - "Submit"
[4] a - "Forgot password?"
```

**Labels** are your handles. Use `{ "type": "click", "label": 0 }` to click "Sign In".

**Element types tell you what to do:**
- `button`, `a` → click
- `input`, `textarea` → type
- `select` → click to open, then click option
- `checkbox`, `radio` → click to toggle

**Text content helps identify purpose:**
- Empty input with placeholder "Search" → search box
- Button with "Submit" → form submission
- Link with "Next" → pagination

**If element not found:**
1. Scroll down - element may be below viewport
2. Look for similar text - "Log In" vs "Sign In"
3. Check if page needs to load - wait and re-observe
4. Report stuck if truly not findable

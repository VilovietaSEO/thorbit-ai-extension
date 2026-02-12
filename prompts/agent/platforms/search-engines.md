---
name: search-engines
version: "1.0"
loadWhen: context.platform in ["google", "bing", "duckduckgo"]
priority: 20
tokens: ~200
---

## Search Engine Patterns

**Google:**
- Search box: large input, usually labeled or has "Search" placeholder
- "Google Search" button or press Enter to search
- Results: blue links are organic, "Ad" label = paid
- "People also ask" → expandable questions
- Images, Videos, News tabs at top

**Bing:**
- Search box center of homepage
- Results similar to Google layout
- Sidebar may have AI chat (Copilot)

**DuckDuckGo:**
- Search box center, privacy-focused
- No tracking, results may differ from Google
- Bang commands (!g, !w) for shortcuts

**Common actions:**
1. Navigate to search engine
2. Find search input (usually [0] or [1])
3. Type query
4. Press Enter or click search button
5. Wait for results
6. Click desired result link

**Tips:**
- Search results are links - click to navigate
- "Next" or pagination at bottom for more results
- Use quotes for exact phrases: "exact match"

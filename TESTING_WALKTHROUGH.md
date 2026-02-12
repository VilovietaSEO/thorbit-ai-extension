# Chrome Extension AI Assistant - Testing Walkthrough

## Quick Start (5 minutes)

### Step 1: Load the Extension in Chrome

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (toggle in top-right corner)
3. Click **Load unpacked**
4. Navigate to and select the `chrome-extension-ai-assistant/` folder
   - **Important**: Don't select the `backend-proxy/` subfolder - select the parent folder
5. You should see "AI Page Assistant" appear with version 1.0.0

### Step 2: Configure Your API Keys

1. Right-click the extension icon → **Options**
   - Or click the puzzle piece icon → AI Page Assistant → three dots → Options
2. In the **AI Provider** section:
   - **Active Provider**: Choose "Anthropic (Claude)" or "OpenRouter"
   - **API Keys**: Enter your keys (already available in your .env):
     - Anthropic: `sk-ant-api03-dHeEKy...` (starts with sk-ant-)
     - OpenRouter: `sk-or-v1-1e7a5fc...` (starts with sk-or-)
3. Settings auto-save - watch for "All changes saved" in the footer

### Step 3: Test the Side Panel

1. Navigate to any website (e.g., https://github.com)
2. Click the extension icon in the toolbar → Side panel opens
3. Type a message like "What is this page about?" and press Enter
4. You should see the AI streaming a response

### Step 4: Test the Popup (Task Management)

1. Click the extension icon (don't click to open side panel, just single click)
2. The popup shows a task list
3. Add a task: type in the input field and click the + button
4. Notice the badge counter on the extension icon updates

---

## What's Actually Built

### Components You Can Test

| Component | How to Access | What It Does |
|-----------|---------------|--------------|
| **Side Panel** | Click extension icon | AI chat, DOM analysis |
| **Popup** | Hover/click extension icon | Quick task management |
| **Options Page** | Right-click → Options | Full settings configuration |
| **Badge Counter** | Look at extension icon | Shows pending task count |

### Settings Available (Options Page)

| Setting | Description |
|---------|-------------|
| **Provider** | Anthropic, OpenRouter, or Custom endpoint |
| **Model** | Claude Sonnet 4, GPT-4 Turbo, Gemini Pro, etc. |
| **API Keys** | BYOK - Bring Your Own Key |
| **System Prompt** | Custom instructions (up to 10,000 chars) |
| **Site Rules** | Allow/block specific sites |
| **Max Tokens** | 10,000 - 200,000 (controls cost) |
| **Theme** | System, Light, Dark |

---

## Available Models

### When using Anthropic directly:
- Claude Sonnet 4 (Recommended)
- Claude 3.5 Sonnet
- Claude 3 Opus
- Claude 3 Haiku (Fast, cheap)

### When using OpenRouter:
- `anthropic/claude-3.5-sonnet` - Claude via OpenRouter
- `openai/gpt-4-turbo` - GPT-4 Turbo
- `google/gemini-pro` - Gemini Pro
- Plus 400+ more models available

---

## Troubleshooting

### Extension won't load
- Make sure you selected the correct folder (not `backend-proxy/`)
- Check `chrome://extensions` for error messages

### "No AI provider configured" error
1. Go to Options (right-click extension → Options)
2. Enter your API key for your chosen provider
3. Click somewhere else to trigger auto-save

### Side panel doesn't open
- Click directly on the extension icon (not the popup arrow)
- Check if the site allows extensions (some Chrome pages block them)

### API errors
- Check your API key is correct
- Check your API account has credits
- OpenRouter: Make sure you have credits in your OpenRouter account

---

## File Structure (What You're Testing)

```
chrome-extension-ai-assistant/
├── manifest.json          # Extension configuration
├── service-worker.js      # Background orchestration
├── content-script.js      # DOM extraction + site rules
├── offscreen.js           # AI API calls
├── sidepanel/             # Chat UI
├── popup/                 # Task management
├── options/               # Settings page
├── styles/                # Thorbit design tokens
├── fonts/                 # GT Flexa typography
└── utils/
    ├── settings-manager.js
    └── providers/         # AI provider abstraction
```

---

## Packaging for Distribution

### Create a ZIP for Chrome Web Store:
```bash
# From project root
cd chrome-extension-ai-assistant
zip -r ../thorbit-ai-extension.zip . -x "backend-proxy/*" -x "*.md" -x ".git/*"
```

### For a separate GitHub repo:
```bash
# Create clean copy
mkdir -p ~/thorbit-ai-extension
cp -r chrome-extension-ai-assistant/* ~/thorbit-ai-extension/
rm -rf ~/thorbit-ai-extension/backend-proxy  # Server is separate
cd ~/thorbit-ai-extension
git init
git add .
git commit -m "Initial commit: Thorbit AI Page Assistant Chrome Extension"
```

---

## What's NOT Included Yet

The following features from the future vision are not yet implemented:

1. **External database connection** - Tasks are stored locally in Chrome storage
2. **Task approval workflow** - Basic add/complete/delete only
3. **Backend sync** - Would require running the `backend-proxy/` server
4. **Computer use/screenshots** - Requires Claude's computer_use API (Opus 4.5+ only)

These can be added in a future iteration.

---

## Your API Keys

Get your API keys from:
- **Anthropic**: https://console.anthropic.com/settings/keys
- **OpenRouter**: https://openrouter.ai/keys

Copy your keys into the Options page when setting up.

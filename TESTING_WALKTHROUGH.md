# Chrome Extension AI Assistant - Testing Walkthrough

## Quick Start (5 minutes)

### Step 1: Load the Extension in Chrome

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (toggle in top-right corner)
3. Click **Load unpacked**
4. Navigate to and select this folder
5. You should see "AI Page Assistant" appear with version 1.0.0

### Step 2: Configure Your API Keys

1. Right-click the extension icon → **Options**
2. In the **AI Provider** section:
   - **Active Provider**: Choose "Anthropic (Claude)" or "OpenRouter"
   - **API Keys**: Enter your keys from your provider dashboard
3. Settings auto-save - watch for "All changes saved" in the footer

### Step 3: Test the Side Panel

1. Navigate to any website (e.g., https://github.com)
2. Click the extension icon in the toolbar → Side panel opens
3. Type a message like "What is this page about?" and press Enter
4. You should see the AI streaming a response

### Step 4: Test the Popup (Task Management)

1. Click the extension icon (single click)
2. The popup shows a task list
3. Add a task: type in the input field and click the + button
4. Notice the badge counter on the extension icon updates

---

## Components

| Component | How to Access | What It Does |
|-----------|---------------|--------------|
| **Side Panel** | Click extension icon | AI chat, DOM analysis |
| **Popup** | Hover/click extension icon | Quick task management |
| **Options Page** | Right-click → Options | Full settings configuration |
| **Badge Counter** | Look at extension icon | Shows pending task count |

## Settings Available (Options Page)

| Setting | Description |
|---------|-------------|
| **Provider** | Anthropic, OpenRouter, or Custom endpoint |
| **Model** | Claude Sonnet 4, GPT-4 Turbo, Gemini Pro, etc. |
| **API Keys** | BYOK - Bring Your Own Key |
| **System Prompt** | Custom instructions (up to 10,000 chars) |
| **Site Rules** | Allow/block specific sites |
| **Max Tokens** | 10,000 - 200,000 (controls cost) |
| **Theme** | System, Light, Dark |

## Available Models

### Anthropic (direct):
- Claude Sonnet 4 (Recommended)
- Claude 3.5 Sonnet
- Claude 3 Opus
- Claude 3 Haiku (Fast)

### OpenRouter:
- `anthropic/claude-3.5-sonnet`
- `openai/gpt-4-turbo`
- `google/gemini-pro`
- Plus 400+ more models

## Troubleshooting

### Extension won't load
- Check `chrome://extensions` for error messages

### "No AI provider configured" error
1. Go to Options (right-click extension → Options)
2. Enter your API key for your chosen provider

### API errors
- Verify your API key is correct
- Check your account has credits

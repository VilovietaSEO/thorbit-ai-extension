# Privacy Policy for AI Page Analyzer Chrome Extension

**Last Updated:** February 2026

**Effective Date:** February 2026

---

## Overview

AI Page Analyzer ("the Extension") is a Chrome browser extension that provides AI-powered analysis of web page content. This Privacy Policy describes how we collect, use, and protect your information when you use the Extension.

Your privacy is important to us. We designed this extension with privacy-first principles, minimizing data collection while providing powerful AI-assisted web page analysis.

---

## Information We Collect

### 1. Page Content Data (Temporarily Processed)

**What we collect:**
- DOM (Document Object Model) structure of web pages you analyze
- Page title and URL of pages you choose to analyze
- Visible text content within the viewport

**Why we collect it:**
- To provide AI-powered page analysis functionality
- To extract relevant information from web pages as requested by you

**How we handle it:**
- Page content is processed only when you explicitly request an analysis
- Data is sent to our AI processing service (Anthropic Claude API) for analysis
- Data is NOT stored persistently after analysis is complete
- Data is NOT used for training AI models

### 2. User Preferences and Settings

**What we collect:**
- Extension settings (stored locally in your browser)
- Conversation history within the side panel (stored locally in your browser session)
- Authentication tokens (stored locally, encrypted)

**Why we collect it:**
- To maintain your preferences across browser sessions
- To provide conversation context within a session
- To authenticate your access to the service

**How we handle it:**
- All preference data is stored locally in your browser using Chrome's storage APIs
- Session data is cleared when you close the browser
- We never transmit your settings to external servers (except authentication tokens to our secure backend)

### 3. Authentication Information

**What we collect:**
- Session tokens for API authentication
- No passwords or credentials are stored in the extension

**Why we collect it:**
- To verify your authorization to use premium features
- To prevent unauthorized API usage

**How we handle it:**
- Tokens are stored securely in Chrome's local storage
- Tokens expire after 30 days and must be refreshed
- Tokens are transmitted only over HTTPS connections

---

## Information We Do NOT Collect

We explicitly do NOT collect:

- Your browsing history (we only process pages you explicitly analyze)
- Personal identification information (name, email, address)
- Financial information
- Passwords or login credentials to other websites
- Cookies from websites you visit
- Data from pages you visit but do not analyze

---

## How We Use Your Information

We use the collected information solely for:

1. **Providing the Service**: Processing page content through AI to generate analysis, summaries, and insights
2. **Improving User Experience**: Maintaining your preferences and conversation history within sessions
3. **Service Authentication**: Verifying authorized access to the extension's features

We do NOT use your information for:

- Advertising or marketing
- Training AI models
- Selling to third parties
- Building user profiles
- Tracking your browsing behavior

---

## Third-Party Services

### Anthropic Claude API

We use Anthropic's Claude AI service to process page content and generate analysis. When you request an analysis:

- Page content is sent to Anthropic's servers via secure HTTPS
- Anthropic's data handling is governed by their privacy policy: https://www.anthropic.com/privacy
- Anthropic does not use API data to train their models
- Data is processed and immediately discarded after generating a response

### Backend Authentication Service

We operate a backend service solely for:

- Authenticating extension users
- Proxying API requests to protect API keys
- Rate limiting to prevent abuse

Our backend does NOT:

- Store page content
- Log user browsing activity
- Share data with third parties

---

## Data Retention

| Data Type | Retention Period |
|-----------|-----------------|
| Page content for analysis | Not retained - processed and discarded |
| Conversation history | Browser session only - cleared on close |
| User preferences | Until you clear browser data or uninstall |
| Authentication tokens | 30 days - then require refresh |

---

## Data Security

We implement industry-standard security measures:

1. **Encryption in Transit**: All data transmitted to our backend and AI services uses TLS 1.3 encryption
2. **Local Storage Encryption**: Sensitive data in Chrome storage is encrypted
3. **No Remote Code Execution**: All extension code is bundled and reviewed; no external JavaScript is executed
4. **Minimal Permissions**: The extension requests only the permissions necessary for its functionality
5. **API Key Protection**: AI API keys are stored server-side, never in the extension bundle

---

## Your Rights and Controls

### You can:

1. **Choose what to analyze**: The extension only processes pages when you explicitly request it
2. **Clear local data**: Remove all extension data through Chrome's extension settings or by uninstalling
3. **Revoke authentication**: Log out to invalidate your session token
4. **Review permissions**: View all extension permissions in Chrome's extension management page

### To exercise your rights:

- **Delete your data**: Uninstall the extension or clear Chrome storage
- **Request information**: Contact us at privacy@[your-domain].com
- **Opt out**: Simply stop using the extension or don't request analysis

---

## Permissions Justification

The extension requests the following permissions:

| Permission | Purpose |
|------------|---------|
| `activeTab` | Access page content ONLY when you click the extension or request analysis |
| `storage` | Store your preferences and session data locally |
| `sidePanel` | Display the chat interface alongside web pages |
| `alarms` | Maintain connection for streaming AI responses |
| `offscreen` | Process AI responses in a secure, isolated context |

### Host Permissions

| Host | Purpose |
|------|---------|
| `https://api.anthropic.com/*` | Send page content to Claude AI for analysis |
| Backend proxy URL | Authenticate and route API requests |

---

## Children's Privacy

The Extension is not intended for children under 13 years of age. We do not knowingly collect personal information from children under 13. If you believe a child has provided us with personal information, please contact us.

---

## Changes to This Policy

We may update this Privacy Policy from time to time. We will notify you of any changes by:

- Posting the new Privacy Policy in the extension
- Updating the "Last Updated" date at the top of this policy
- For significant changes, displaying a notice in the extension

Your continued use of the Extension after any changes constitutes acceptance of the new Privacy Policy.

---

## Compliance

This extension is designed to comply with:

- **GDPR** (General Data Protection Regulation)
- **CCPA** (California Consumer Privacy Act)
- **Chrome Web Store Developer Program Policies**

---

## Contact Us

If you have questions about this Privacy Policy or our data practices, please contact us at:

- **Email**: privacy@[your-domain].com
- **Website**: https://[your-domain].com/privacy

---

## Summary

- We process page content ONLY when you request analysis
- Page content is NOT stored after processing
- All local data is stored in YOUR browser, not our servers
- We use Anthropic Claude API for AI processing (no training on your data)
- You control what gets analyzed and can delete all data by uninstalling

# Chrome Web Store Submission Checklist

## Pre-Submission Requirements

Complete ALL items before submitting to the Chrome Web Store.

---

## 1. Extension Code Compliance

### Manifest V3 Requirements

- [ ] **manifest_version is 3** - MV2 is no longer accepted
- [ ] **Service worker configured** - Background uses service worker, not persistent page
- [ ] **type: "module"** - Service worker configured as ES module
- [ ] **No persistent background** - No persistent:true in manifest

### Content Security Policy

- [ ] **CSP defined** - `"content_security_policy": { "extension_pages": "script-src 'self'; object-src 'self'" }`
- [ ] **No unsafe-eval** - CSP does not include 'unsafe-eval'
- [ ] **No unsafe-inline** - CSP does not include 'unsafe-inline'

### Remote Hosted Code (RHC)

- [ ] **All JavaScript bundled** - No CDN links to external JavaScript
- [ ] **No dynamic code execution** - No eval(), new Function(), or similar
- [ ] **No remote script loading** - No fetching and executing remote scripts

**Verification:**
```bash
# Check for external script references
grep -r "https://" --include="*.js" --include="*.html" | grep -v "api.anthropic.com"
# Should only show API endpoints, not script sources
```

### Permissions

- [ ] **Minimal permissions** - Only request what's needed
- [ ] **No <all_urls>** - Unless absolutely necessary (triggers manual review)
- [ ] **host_permissions justified** - Each external domain has clear purpose
- [ ] **activeTab preferred** - Over broad host_permissions where possible

---

## 2. Required Assets

### Icons

- [ ] **icon-16.png** - 16x16 pixels, PNG format
- [ ] **icon-48.png** - 48x48 pixels, PNG format
- [ ] **icon-128.png** - 128x128 pixels, PNG format
- [ ] **Icons are square** - Equal width and height
- [ ] **Icons are PNG** - Not JPG, GIF, or other formats

**Verification:**
```bash
# Check icon dimensions
file assets/icon-*.png
# Should show: PNG image data, 16 x 16, 48 x 48, 128 x 128
```

### Screenshots

- [ ] **At least 1 screenshot** - Required for listing
- [ ] **Recommended: 5 screenshots** - Show different features
- [ ] **Dimensions: 1280x800 or 640x400** - Exact dimensions required
- [ ] **PNG or JPG format** - Other formats not accepted
- [ ] **No text-only screenshots** - Must show actual extension UI
- [ ] **Accurate representation** - Shows real extension behavior

### Promotional Images (Optional but Recommended)

- [ ] **Small tile: 440x280** - For search results
- [ ] **Large tile: 920x680** - For featured sections
- [ ] **Marquee: 1400x560** - For hero placement

---

## 3. Store Listing Content

### Required Fields

- [ ] **Extension name** - Max 45 characters
- [ ] **Short description** - Max 132 characters
- [ ] **Detailed description** - Max 16,000 characters
- [ ] **Category selected** - e.g., Productivity
- [ ] **Language selected** - e.g., English (US)

### Privacy Policy

- [ ] **Privacy policy URL provided** - Publicly accessible URL
- [ ] **Privacy policy is accessible** - URL returns 200 OK
- [ ] **Policy covers data collection** - Describes what data is collected
- [ ] **Policy covers data usage** - Describes how data is used
- [ ] **Policy covers third parties** - Lists third-party services

### Single Purpose Description

- [ ] **Single purpose clearly stated** - One clear main function
- [ ] **Matches actual functionality** - Description matches what extension does

---

## 4. Permissions Justification

For each permission, provide justification in the "Single Purpose" section:

### Core Permissions

- [ ] **activeTab** - "Required to read page content when user explicitly requests analysis"
- [ ] **storage** - "Required to store user preferences and conversation history locally"
- [ ] **sidePanel** - "Required to display the chat interface for AI conversations"
- [ ] **alarms** - "Required to maintain service worker during AI processing (Chrome terminates workers after 30 seconds)"
- [ ] **offscreen** - "Required to process AI API responses (service workers lack DOM APIs needed for parsing)"

### Host Permissions

- [ ] **https://api.anthropic.com/*** - "Required to send page content to Claude AI for analysis"
- [ ] **Backend URL (if used)** - "Required for authentication and API request proxying"

---

## 5. Security Verification

### API Keys

- [ ] **No API keys in code** - Grep for "sk-", "api-key", etc.
- [ ] **Keys in environment/backend** - Stored server-side only
- [ ] **No secrets in manifest** - No credentials in manifest.json

**Verification:**
```bash
# Search for potential API keys
grep -r "sk-" --include="*.js"
grep -r "api.key" --include="*.js"
grep -r "API_KEY" --include="*.js"
# Should return no results or only variable declarations
```

### Input Validation

- [ ] **Content script data sanitized** - Before sending to AI
- [ ] **Message types validated** - Unknown types rejected
- [ ] **Text truncated** - Prevent prompt injection via long text

---

## 6. Functionality Testing

### Core Features

- [ ] **Extension installs** - Loads without errors in chrome://extensions
- [ ] **Icon displays correctly** - All sizes render properly
- [ ] **Side panel opens** - Clicking icon opens side panel
- [ ] **DOM extraction works** - Content is extracted from pages
- [ ] **AI analysis returns** - Responses are received and displayed
- [ ] **Streaming works** - Responses stream in real-time
- [ ] **Errors handled gracefully** - User-friendly error messages

### Service Worker Lifecycle

- [ ] **Worker starts** - On extension load
- [ ] **Worker survives inactivity** - Via Chrome Alarms
- [ ] **State persists** - After worker termination
- [ ] **Offscreen recovers** - After document closure

### Cross-Browser Testing

- [ ] **Chrome Stable** - Latest stable version
- [ ] **Chrome Beta** - Current beta version
- [ ] **Chrome Canary** - Current canary (optional)

---

## 7. Developer Dashboard Submission

### Account Setup

- [ ] **Developer account created** - At https://chrome.google.com/webstore/devconsole
- [ ] **Registration fee paid** - One-time $5 USD
- [ ] **Developer agreement accepted** - Terms of service

### Package Preparation

- [ ] **ZIP file created** - Contains extension directory
- [ ] **No development files** - Remove .git, node_modules, etc.
- [ ] **No source maps** - Remove .map files for production
- [ ] **File size under 500MB** - Chrome Web Store limit

**Creating ZIP:**
```bash
# From extension directory
cd chrome-extension-ai-assistant

# Remove development files
rm -rf node_modules .git .gitignore *.map

# Create ZIP
zip -r ../chrome-extension-ai-assistant.zip .
```

### Submission Steps

1. [ ] Go to Chrome Web Store Developer Dashboard
2. [ ] Click "New Item"
3. [ ] Upload ZIP file
4. [ ] Fill in store listing details
5. [ ] Upload screenshots
6. [ ] Add privacy policy URL
7. [ ] Complete permission justifications
8. [ ] Set visibility (Public/Unlisted)
9. [ ] Submit for review

---

## 8. Post-Submission

### Review Process

- **Timeline**: 1-7 business days (sometimes longer)
- **Status**: Check dashboard for review status
- **Rejections**: Will include reason and remediation steps

### Common Rejection Reasons

| Reason | Solution |
|--------|----------|
| Remote hosted code | Bundle all JavaScript |
| Insufficient permission justification | Provide detailed explanations |
| Privacy policy missing/inaccessible | Ensure URL works and covers requirements |
| Misleading functionality | Match description to actual behavior |
| Excessive permissions | Remove unnecessary permissions |
| Single purpose violation | Focus on one clear function |

### After Approval

- [ ] **Test published version** - Install from store and verify
- [ ] **Monitor reviews** - Respond to user feedback
- [ ] **Track analytics** - Use Chrome Web Store analytics

---

## Quick Reference: Submission Checklist Summary

```
PRE-SUBMISSION
[x] Code uses Manifest V3
[x] All JavaScript bundled (no CDN)
[x] No API keys in code
[x] Strict CSP configured
[x] Minimal permissions requested

ASSETS
[x] icon-16.png (16x16)
[x] icon-48.png (48x48)
[x] icon-128.png (128x128)
[x] 1-5 screenshots (1280x800 or 640x400)

LISTING
[x] Name (max 45 chars)
[x] Short description (max 132 chars)
[x] Detailed description
[x] Privacy policy URL
[x] Category selected

JUSTIFICATIONS
[x] Each permission justified
[x] Single purpose documented

TESTING
[x] Extension loads without errors
[x] All features work
[x] State persists correctly
[x] Errors handled gracefully

SUBMISSION
[x] ZIP file created
[x] Dashboard form complete
[x] Submitted for review
```

---

## Emergency Checklist: Rejected Submission

If your submission is rejected:

1. [ ] **Read rejection reason carefully** - Note specific issues
2. [ ] **Address ALL mentioned issues** - Don't submit until all fixed
3. [ ] **Re-verify with this checklist** - May have uncovered other issues
4. [ ] **Update version number** - Increment in manifest.json
5. [ ] **Create new ZIP** - Don't modify the old one
6. [ ] **Resubmit** - Upload new package
7. [ ] **Include response** - Explain what was fixed in submission notes

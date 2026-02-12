---
name: form-filling
version: "1.0"
loadWhen: context.hasForm == true
priority: 20
tokens: ~250
---

## Form Handling

**Identifying form fields:**
- `input` with type: text, email, password, tel, number, date
- `textarea` for multi-line text
- `select` for dropdowns
- `checkbox` and `radio` for options
- Labels often adjacent or associated via `for` attribute

**Filling strategy:**
1. Identify all required fields (often marked with *)
2. Fill fields in order (top to bottom, left to right)
3. For dropdowns: click to open, then click option
4. For checkboxes: click to toggle
5. Wait briefly between fields for validation

**Common field patterns:**
- Name fields: "First Name", "Last Name" or single "Full Name"
- Email: validate format before moving on
- Password: may have requirements (length, special chars)
- Phone: may need specific format
- Address: street, city, state/province, zip/postal, country

**Handling validation:**
- Red borders or error messages indicate invalid input
- Fix the field and re-submit
- Some forms validate on blur (leaving field), others on submit

**Submit actions:**
- Look for "Submit", "Send", "Continue", "Next" buttons
- May be at bottom of form
- Disabled buttons indicate required fields missing

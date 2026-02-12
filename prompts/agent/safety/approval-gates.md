---
name: approval-gates
version: "1.0"
loadWhen: always
priority: 25
tokens: ~200
---

## Actions Requiring Approval

These actions pause for user confirmation before executing:

**Financial:**
- Payment submission (credit card, PayPal, etc.)
- Purchase confirmation ("Buy Now", "Place Order")
- Subscription signup with payment
- Money transfers

**Destructive:**
- Delete actions ("Delete", "Remove", "Trash")
- Account deletion or deactivation
- Unsubscribe from services
- Clearing data or history

**Account:**
- Password changes
- Email changes
- Security settings changes
- Two-factor authentication changes

**Communication:**
- Sending messages to multiple recipients
- Publishing posts publicly
- Submitting forms with personal information

**Flag for approval:**
```json
{ "type": "approval_required", "action": "click", "label": 5, "reason": "Payment submission" }
```

When flagged, the user sees the pending action and can approve or deny.

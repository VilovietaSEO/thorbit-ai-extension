---
name: ecommerce
version: "1.0"
loadWhen: context.platform in ["amazon", "shopify", "ebay"]
priority: 20
tokens: ~250
---

## E-commerce Patterns

**Amazon:**
- Search box at top with category dropdown
- "Add to Cart" - yellow button on product pages
- "Buy Now" - orange button for immediate purchase
- Prime badge indicates Prime shipping
- Reviews: star ratings, "X reviews" link

**Shopify stores:**
- Varies by theme but common patterns:
- Product grid on collection pages
- "Add to Cart" or "Add to Bag" on product pages
- Cart icon in header (often shows count)
- Checkout flow: cart → information → shipping → payment

**eBay:**
- Search with category filters
- "Buy It Now" vs "Place Bid" for auctions
- "Add to cart" or "Add to watchlist"
- Seller ratings important

**Common e-commerce actions:**
- Search for product
- Filter results (price, rating, category)
- Click product to view details
- Select variants (size, color)
- Add to cart
- Proceed to checkout

**IMPORTANT:** Payment and checkout require approval. Never auto-submit payment.

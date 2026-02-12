---
name: social-media
version: "1.0"
loadWhen: context.platform in ["facebook", "twitter", "linkedin", "instagram"]
priority: 20
tokens: ~350
---

## Social Media Patterns

**Facebook:**
- Feed posts have like, comment, share buttons
- "What's on your mind?" → composer for new posts
- Notifications bell top-right
- Profile access via avatar or name

**Twitter/X:**
- Tweet button usually prominent (quill icon)
- Like = heart, Retweet = arrows, Reply = speech bubble
- "What's happening?" → compose tweet
- Home, Explore, Notifications, Messages in sidebar

**LinkedIn:**
- "Start a post" in feed composer
- Like, Comment, Repost, Send buttons on posts
- Connection requests in "My Network"
- Messages via messaging icon

**Instagram:**
- Heart = like, Speech bubble = comment, Paper plane = share/DM
- Plus icon or camera = new post/story
- Profile via avatar bottom-right
- Explore via magnifying glass

**Common patterns:**
- Infinite scroll - content loads as you scroll
- Modals for compose/post creation
- Real-time updates - page content changes without navigation
- Login walls - some features require authentication

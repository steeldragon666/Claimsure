# Marketing videos — drop point

This directory is read by the landing page (`apps/web/src/app/page.tsx`) and
`/marketing/videos/<id>.mp4` URLs resolve from here at build time.

## Required files (drop them in this directory):

| ID                | Filename               | Aspect | Caption (canonical)                              |
| ----------------- | ---------------------- | ------ | ------------------------------------------------ |
| index-explainer   | index-explainer.mp4    | 16:9   | Hero / main explainer (auto-plays muted on load) |
| signup            | signup-demo.mp4        | 16:9   | Signup → workspace provisioned                   |
| evidence-mobile   | evidence-mobile.mp4    | 9:16   | Evidence capture — claimant mobile app           |
| evidence-desktop  | evidence-desktop.mp4   | 16:9   | Evidence intake — consultant workspace           |
| activity-register | activity-register.mp4  | 16:9   | Activity register synthesis                      |
| narrative         | narrative-drafting.mp4 | 16:9   | Narrative drafting with citations                |
| export            | claim-pack-export.mp4  | 16:9   | Claim pack export → ATO-ready                    |

## Poster images (optional — recommended)

Same basename + `-poster.jpg`. e.g. `signup-poster.jpg`.

If posters are missing, the `<video>` will show a black frame until play.

## Sizing guidance

- Target 5-15 MB per video, h264 mp4, optimised with `ffmpeg -crf 28 -preset slow`
- Posters: 1920x1080 JPG (or 1080x1920 for 9:16), under 200 KB

## Alternate hosting

If files exceed ~80 MB total, replace the `/marketing/videos/...` paths in
`apps/web/src/app/page.tsx` with absolute URLs to Cloudflare R2 / S3 / YouTube
embeds. The video component is local-or-remote-URL agnostic.

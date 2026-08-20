# Listing Video Tour Generator

Turns staged listing photos into a single stitched AI video tour using Runway's
`gen4_turbo` image-to-video model. Upload one photo per room, tag each with a room
type, and it generates a ~5 second clip per room, then stitches them in order into
one MP4.

## How it works

1. You upload photos through the web form and tag each one with a room type
   (kitchen, living room, exterior, etc.)
2. The server sends each photo to Runway's `image_to_video` endpoint with a
   room-specific camera-motion prompt (a slow glide/pan — the motion style
   that holds up best for empty/staged interiors)
3. It polls each Runway task until the clip is ready, downloads them
4. `ffmpeg` concatenates the clips in your original photo order into one MP4
5. You get a video player + download link

No prompt-writing required day to day — the room-type prompts are baked in
(`ROOM_PROMPTS` in `server.js`), so tagging a photo "Kitchen" is enough.

## Cost per tour

Runway's `gen4_turbo` is priced per second of generated video (~$0.01/sec as of
mid-2026). A 5-second clip per room means roughly **$0.05 per room**, so an
8-10 room listing runs **well under $1** in API cost. Keep an eye on your credit
balance in the Runway dev dashboard — this app doesn't track spend itself.

## Local setup

```bash
npm install
cp .env.example .env
# edit .env and add your RUNWAYML_API_SECRET and a SITE_PASSWORD
npm start
```

Requires `ffmpeg` installed locally if running outside Docker
(`brew install ffmpeg` on Mac, `apt install ffmpeg` on Linux).

## Deployment (recommended: Render)

This app needs a real server — not a static site — because it holds your Runway
API key server-side and shells out to `ffmpeg`. Render's free/cheap web service
tier handles both cleanly via the included `Dockerfile`, and deploys straight
from a GitHub repo the same way your listing site repos do.

1. Push this folder to a new repo in your `nathanirving1984-maker` GitHub org
   (e.g. `listing-video-tours`)
2. Go to [render.com](https://render.com), sign up/log in, click **New > Web Service**
3. Connect your GitHub account and select the repo
4. Render will detect the `Dockerfile` automatically — leave build settings as default
5. Under **Environment**, add two environment variables:
   - `RUNWAYML_API_SECRET` — your Runway key
   - `SITE_PASSWORD` — whatever shared password you want to gate access with
     (this keeps a stray link from burning through your credits)
6. Deploy. Render gives you a URL like `listing-video-tours.onrender.com` —
   you can point a custom domain at it later the same way you would for a
   listing microsite.

**Note on the free tier:** Render's free web services spin down after
inactivity and take ~30-60 seconds to wake up on the next request. Fine for
occasional personal/colleague use; upgrade to a paid instance ($7/mo) if that
delay becomes annoying.

## Known limitations (fine for this scope, worth knowing)

- No drag-to-reorder on the photo list yet — clips stitch in upload order
- No persistent job history — each generation is one-shot, video lives at a
  URL until the server's disk cycles it out (fine for "download it right after")
- Single shared password, not per-user accounts — matches the "just me and a
  few colleagues" scope; would need real auth to open this up further
- No compliance/disclaimer overlay yet — if this ever gets shared outside a
  small trusted group, revisit the EHO/DRE# branding question the same way we
  flagged it for the listing site generator

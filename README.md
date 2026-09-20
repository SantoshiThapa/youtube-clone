# CloneTube — Chapter 14 "Design YouTube" hands-on build

This is a scaled-down, runnable version of the architecture from *System
Design Interview* by Alex Xu, Chapter 14. It keeps every component the
chapter names, just swapped for local/free equivalents so you can run it
on your own machine.

| Book component        | This project                                   |
|------------------------|-------------------------------------------------|
| Client                 | `client/` (plain HTML/JS)                       |
| API servers            | `api-server/` (Express)                         |
| Metadata DB            | MongoDB (via Docker)                            |
| Metadata cache         | Redis (via Docker)                              |
| Original storage (blob)| `storage/original/` folder                      |
| Transcoding servers    | `transcoding-worker/` (ffmpeg)                  |
| Transcoded storage     | `storage/transcoded/` folder                    |
| Completion queue       | BullMQ `transcode-queue` + `completion-queue`   |
| Completion handler     | `completion-handler/`                           |
| CDN                    | Express static server (`/cdn` route)            |
| Pre-signed upload URL  | Simulated 2-step upload-url + upload endpoint   |
| Streaming protocol     | HLS (`.m3u8` + `.ts` segments), played via hls.js|

There are **4 processes** you'll run side by side: MongoDB+Redis (Docker),
the API server, the transcoding worker, and the completion handler — plus
a static server for the client. This mirrors the book's point that
upload, transcoding, and metadata updates are separate, decoupled services
talking through a queue.

---

## 1. What to install

1. **Node.js** (v18 or later) — https://nodejs.org (LTS version)
2. **ffmpeg** — the actual video transcoder used by the worker
   - Windows: https://www.gyan.dev/ffmpeg/builds/ (download, unzip, add the
     `bin` folder to your PATH)
   - Mac: `brew install ffmpeg`
   - Linux: `sudo apt install ffmpeg`
   - Verify with `ffmpeg -version` in a terminal.
3. **Docker Desktop** — https://www.docker.com/products/docker-desktop
   (runs MongoDB + Redis for you with one command; no manual DB install)
4. **VS Code** — https://code.visualstudio.com

## 2. VS Code extensions (Extensions tab, Ctrl+Shift+X)

- **ESLint** (dbaeumer.vscode-eslint) — catches JS errors as you type
- **Live Server** (ritwickdey.LiveServer) — lets you open `client/index.html`
  with a real local server (needed for `fetch` calls to work properly)
- **MongoDB for VS Code** (mongodb.mongodb-vscode) — browse your video
  metadata collection visually
- **Docker** (ms-azuretools.vscode-docker) — manage the Mongo/Redis
  containers from the sidebar
- **Thunder Client** (rangav.vscode-thunder-client) — test the API
  endpoints (upload-url, videos list, etc.) without leaving VS Code
- (optional) **DotENV** (mikestead.dotenv) — syntax highlighting for `.env`

## 3. First-time setup

```bash
# 1. Start Mongo + Redis
docker compose up -d

# 2. Install dependencies for each service
cd api-server && npm install && cp .env.example .env && cd ..
cd transcoding-worker && npm install && cp .env.example .env && cd ..
cd completion-handler && npm install && cp .env.example .env && cd ..
```

## 4. Running it (open 3 terminals in VS Code)

```bash
# Terminal 1
cd api-server && npm run dev

# Terminal 2
cd transcoding-worker && npm start

# Terminal 3
cd completion-handler && npm start
```

Then in VS Code: right-click `client/index.html` → **Open with Live
Server**. It'll open in your browser (usually `http://127.0.0.1:5500`).

## 5. Try the full flow

1. Go to the **Upload** page, pick a small `.mp4` (a 10–30 second clip is
   plenty for testing), give it a title, hit Upload.
2. Watch Terminal 1 log the upload, Terminal 2 log ffmpeg running through
   360p/480p/720p renditions + thumbnail, Terminal 3 log the completion
   event marking the video "ready".
3. You'll be redirected to the watch page, which polls every 3s until
   `status: "ready"`, then plays the adaptive HLS stream. Use the
   resolution buttons to switch between "Auto" and forced resolutions —
   this is the "ability to change video quality" requirement from the
   book's scope.

## 6. Where to look if you want to extend it (matches the chapter's "Wrap up")

- **Error handling / retries**: `api-server/src/queue.js` already sets
  `attempts: 3` on the BullMQ job — try killing the worker mid-transcode
  and see it retry.
- **Scaling the API tier**: since `api-server` is stateless, you could run
  two instances behind a simple load balancer (e.g. nginx) with no code
  changes.
- **Cost-saving / CDN**: right now every video is served the same way;
  the book suggests only CDN-caching *popular* videos and serving the
  long tail from regular storage — you could fake "popularity" with a
  view counter and branch the `/cdn` route accordingly.
- **Video takedowns / DRM**: not implemented — out of scope for a local
  demo, but worth mentioning if this comes up in an interview.

## Troubleshooting

- **"ffmpeg not found"**: make sure `ffmpeg -version` works in the exact
  same terminal you run `npm start` from (PATH issues are the usual
  culprit on Windows).
- **CORS errors in the browser**: make sure you're opening the client via
  Live Server (`http://127.0.0.1:5500`), not by double-clicking the HTML
  file (`file://` URLs break `fetch`).
- **Video stuck on "processing"**: check Terminal 2 (transcoding-worker)
  for ffmpeg errors — usually means the uploaded file isn't a valid video.
- **Docker containers not starting**: run `docker compose logs` to see
  why Mongo/Redis failed (port 27017/6379 already in use is the common
  case — stop any local Mongo/Redis you already have running).

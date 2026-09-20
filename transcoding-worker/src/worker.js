require("dotenv").config();
const path = require("path");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");
const { Worker, Queue } = require("bullmq");
const cloudinary = require("cloudinary").v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const connection = { url: process.env.REDIS_URL || "redis://localhost:6379" };

const TRANSCODED_DIR = path.resolve(
  __dirname,
  "../../",
  process.env.TRANSCODED_STORAGE_DIR || "../storage/transcoded"
);

const completionQueue = new Queue("completion-queue", { connection });

const RENDITIONS = [
  { label: "360p", height: 360, videoBitrate: "800k", audioBitrate: "96k" },
  { label: "480p", height: 480, videoBitrate: "1400k", audioBitrate: "128k" },
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function generateThumbnail(inputPath, outputDir) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .on("end", () => resolve(path.join(outputDir, "thumbnail.jpg")))
      .on("error", reject)
      .screenshots({
        timestamps: ["1"],
        filename: "thumbnail.jpg",
        folder: outputDir,
        size: "640x360",
      });
  });
}

function transcodeRendition(inputPath, outputDir, rendition) {
  const renditionDir = path.join(outputDir, rendition.label);
  ensureDir(renditionDir);
  const playlistPath = path.join(renditionDir, "playlist.m3u8");

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .videoCodec("libx264")
      .audioCodec("aac")
      .audioBitrate(rendition.audioBitrate)
      .videoBitrate(rendition.videoBitrate)
      .size(`?x${rendition.height}`)
      .outputOptions([
        "-preset veryfast",
        "-sc_threshold 0",
        "-g 48",
        "-keyint_min 48",
        "-hls_time 4",
        "-hls_playlist_type vod",
        `-hls_segment_filename ${path.join(renditionDir, "seg_%03d.ts")}`,
      ])
      .output(playlistPath)
      .on("start", (cmd) => console.log(`[worker] ffmpeg start (${rendition.label}):`, cmd))
      .on("error", reject)
      .on("end", () => resolve({ label: rendition.label, renditionDir, playlistPath }))
      .run();
  });
}

async function uploadRaw(localPath, publicId) {
  const result = await cloudinary.uploader.upload(localPath, {
    resource_type: "raw",
    public_id: publicId,
    overwrite: true,
  });
  return result.secure_url;
}

async function uploadSegments(renditionDir, videoId, label) {
  const files = fs.readdirSync(renditionDir).filter((f) => f.endsWith(".ts"));
  const urlMap = {};
  for (const file of files) {
    const localPath = path.join(renditionDir, file);
    const publicId = `youtube-clone/${videoId}/${label}/${file}`;
    urlMap[file] = await uploadRaw(localPath, publicId);
  }
  return urlMap;
}

async function uploadRewrittenPlaylist(playlistPath, segmentUrlMap, videoId, label) {
  let content = fs.readFileSync(playlistPath, "utf8");
  for (const [filename, url] of Object.entries(segmentUrlMap)) {
    content = content.split(filename).join(url);
  }
  const rewrittenPath = playlistPath.replace(".m3u8", ".rewritten.m3u8");
  fs.writeFileSync(rewrittenPath, content);
  const publicId = `youtube-clone/${videoId}/${label}/playlist.m3u8`;
  return uploadRaw(rewrittenPath, publicId);
}

const worker = new Worker(
  "transcode-queue",
  async (job) => {
    const { videoId, originalFilePath } = job.data;
    console.log(`[worker] transcoding job received for video ${videoId}`);

    const outputDir = path.join(TRANSCODED_DIR, videoId);
    ensureDir(outputDir);

    const thumbnailLocalPath = await generateThumbnail(originalFilePath, outputDir);
    const thumbnailUrl = await uploadRaw(thumbnailLocalPath, `youtube-clone/${videoId}/thumbnail.jpg`);
    console.log(`[worker] thumbnail uploaded for ${videoId}`);

    const renditionResults = [];
    for (const r of RENDITIONS) {
      const local = await transcodeRendition(originalFilePath, outputDir, r);
      console.log(`[worker] uploading ${r.label} segments for ${videoId}...`);
      const segmentUrlMap = await uploadSegments(local.renditionDir, videoId, r.label);
      const playlistUrl = await uploadRewrittenPlaylist(local.playlistPath, segmentUrlMap, videoId, r.label);
      renditionResults.push({ label: r.label, playlistUrl });
      console.log(`[worker] ${r.label} done for ${videoId}`);
    }

    const bandwidthByLabel = { "360p": 900000, "480p": 1500000, "720p": 2900000 };
    const masterLines = ["#EXTM3U"];
    for (const r of renditionResults) {
      masterLines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidthByLabel[r.label] || 1000000},RESOLUTION=${
          r.label === "360p" ? "640x360" : r.label === "480p" ? "854x480" : "1280x720"
        }`
      );
      masterLines.push(r.playlistUrl);
    }
    const masterLocalPath = path.join(outputDir, "master.m3u8");
    fs.writeFileSync(masterLocalPath, masterLines.join("\n"));
    const masterPlaylistUrl = await uploadRaw(masterLocalPath, `youtube-clone/${videoId}/master.m3u8`);

    fs.rmSync(outputDir, { recursive: true, force: true });

    await completionQueue.add("completed", {
      videoId,
      thumbnailUrl,
      masterPlaylistUrl,
      resolutions: renditionResults,
    });

    console.log(`[worker] video ${videoId} transcoded, completion event queued`);
  },
  { connection, concurrency: 1 }
);

worker.on("failed", (job, err) => {
  console.error(`[worker] job ${job.id} failed:`, err.message);
});

console.log("[worker] transcoding worker started, waiting for jobs...");
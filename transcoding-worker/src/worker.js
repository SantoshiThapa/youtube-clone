require("dotenv").config();
const path = require("path");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");
const { Worker, Queue } = require("bullmq");

const connection = { url: process.env.REDIS_URL || "redis://localhost:6379" };

const TRANSCODED_DIR = path.resolve(
  __dirname,
  "../../",
  process.env.TRANSCODED_STORAGE_DIR || "../storage/transcoded"
);

// This is the "Completion queue" from Figure 14-4: once transcoding is
// done, an event is pushed here instead of the worker updating Mongo
// directly. A separate completion-handler service consumes it.
const completionQueue = new Queue("completion-queue", { connection });

// Renditions we generate per video -- stands in for the "Video encodings"
// task in the book's DAG (Figure 14-8), simplified to 3 fixed ladders.
const RENDITIONS = [
  { label: "360p", height: 360, videoBitrate: "800k", audioBitrate: "96k" },
  { label: "480p", height: 480, videoBitrate: "1400k", audioBitrate: "128k" },
  { label: "720p", height: 720, videoBitrate: "2800k", audioBitrate: "128k" },
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
      .on("end", () => resolve({ label: rendition.label, playlistPath }))
      .run();
  });
}

function writeMasterPlaylist(outputDir, renditionResults) {
  const bandwidthByLabel = { "360p": 900000, "480p": 1500000, "720p": 2900000 };
  const lines = ["#EXTM3U"];
  for (const r of renditionResults) {
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidthByLabel[r.label]},RESOLUTION=${
        r.label === "360p" ? "640x360" : r.label === "480p" ? "854x480" : "1280x720"
      }`
    );
    lines.push(`${r.label}/playlist.m3u8`);
  }
  const masterPath = path.join(outputDir, "master.m3u8");
  fs.writeFileSync(masterPath, lines.join("\n"));
  return masterPath;
}

const worker = new Worker(
  "transcode-queue",
  async (job) => {
    const { videoId, originalFilePath } = job.data;
    console.log(`[worker] transcoding job received for video ${videoId}`);

    const outputDir = path.join(TRANSCODED_DIR, videoId);
    ensureDir(outputDir);

    // Run the DAG's tasks. Thumbnail + each rendition are independent
    // branches (see Figure 14-8), so they run in parallel here too.
    const [thumbnailPath, ...renditionResults] = await Promise.all([
      generateThumbnail(originalFilePath, outputDir),
      ...RENDITIONS.map((r) => transcodeRendition(originalFilePath, outputDir, r)),
    ]);

    writeMasterPlaylist(outputDir, renditionResults);

    // Push a completion event instead of touching Mongo from here --
    // keeps the transcoding worker decoupled, as in Figure 14-26.
    await completionQueue.add("completed", {
      videoId,
      thumbnailPath: path.relative(TRANSCODED_DIR, thumbnailPath),
      masterPlaylistPath: path.relative(TRANSCODED_DIR, path.join(outputDir, "master.m3u8")),
      resolutions: renditionResults.map((r) => ({
        label: r.label,
        playlistPath: path.relative(TRANSCODED_DIR, r.playlistPath),
      })),
    });

    console.log(`[worker] video ${videoId} transcoded, completion event queued`);
  },
  { connection, concurrency: 2 }
);

worker.on("failed", (job, err) => {
  console.error(`[worker] job ${job.id} failed:`, err.message);
});

console.log("[worker] transcoding worker started, waiting for jobs...");

require("dotenv").config();
const mongoose = require("mongoose");
const { Worker } = require("bullmq");
const Redis = require("ioredis");
const { v4: uuidv4 } = require("uuid");

const connection = { url: process.env.REDIS_URL || "redis://localhost:6379" };
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

const VideoSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => uuidv4() },
    title: String,
    description: String,
    originalFileName: String,
    originalPath: String,
    sizeBytes: Number,
    status: { type: String, enum: ["uploading", "processing", "ready", "failed"] },
    thumbnailUrl: String,
    masterPlaylistUrl: String,
    resolutions: [{ label: String, playlistUrl: String }],
    uploader: String,
  },
  { timestamps: true }
);
const Video = mongoose.model("Video", VideoSchema);

async function start() {
  await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/youtube_clone");
  console.log("[completion-handler] connected to MongoDB");

  const worker = new Worker(
    "completion-queue",
    async (job) => {
      const { videoId, thumbnailUrl, masterPlaylistUrl, resolutions } = job.data;
      console.log(`[completion-handler] processing completion event for ${videoId}`);

      await Video.findByIdAndUpdate(videoId, {
        $set: {
          status: "ready",
          thumbnailUrl,
          masterPlaylistUrl,
          resolutions,
        },
      });

      await redis.del(`video:${videoId}`);
      await redis.del("video:feed");

      console.log(`[completion-handler] video ${videoId} marked ready`);
    },
    { connection, concurrency: 5 }
  );

  worker.on("failed", (job, err) => {
    console.error(`[completion-handler] job ${job.id} failed:`, err.message);
  });
}

start().catch((err) => {
  console.error("Failed to start completion handler:", err.message);
  process.exit(1);
});

console.log("[completion-handler] started, waiting for completion events...");
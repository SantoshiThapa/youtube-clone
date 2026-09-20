const { Queue } = require("bullmq");

// BullMQ (backed by Redis) plays the role of the message queue that
// decouples "upload" from "transcoding" in the book's Figure 14-25/14-26,
// enabling the parallelism the chapter talks about.
const connection = { url: process.env.REDIS_URL || "redis://localhost:6379" };

const transcodeQueue = new Queue("transcode-queue", { connection });

async function enqueueTranscodeJob(videoId, originalFilePath) {
  await transcodeQueue.add(
    "transcode",
    { videoId, originalFilePath },
    {
      attempts: 3, // "Recoverable error -> retry a few times" (chapter's error handling table)
      backoff: { type: "exponential", delay: 3000 },
      removeOnComplete: true,
      removeOnFail: false,
    }
  );
  console.log(`[queue] enqueued transcode job for video ${videoId}`);
}

module.exports = { transcodeQueue, enqueueTranscodeJob };

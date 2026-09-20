const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");

const Video = require("../models/Video");
const { enqueueTranscodeJob } = require("../queue");
const { invalidateVideo } = require("../cache");

const router = express.Router();

const ORIGINAL_DIR = path.resolve(
  __dirname,
  "../../",
  process.env.ORIGINAL_STORAGE_DIR || "../storage/original"
);
fs.mkdirSync(ORIGINAL_DIR, { recursive: true });

// ---- Step 1: client asks for a "pre-signed URL" -------------------------
// Real YouTube/S3 would hand back a temporary signed URL pointing directly
// at blob storage, so the API server isn't in the hot path of the upload.
// We can't do real S3 pre-signing without a cloud account, so we simulate
// the same *shape* of the flow: generate a videoId + a one-time upload
// endpoint, create a placeholder metadata doc, and hand the URL back.
router.post("/upload-url", async (req, res) => {
  try {
    const videoId = uuidv4();

    await Video.create({
      _id: videoId,
      status: "uploading",
      title: req.body?.title || "Untitled video",
      description: req.body?.description || "",
    });

    res.json({
      videoId,
      uploadUrl: `/api/videos/upload/${videoId}`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to create upload URL" });
  }
});

// ---- Step 2: client uploads the actual bytes to that URL -----------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ORIGINAL_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".mp4";
    cb(null, `${req.params.videoId}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB, same cap the book uses
});

router.post("/upload/:videoId", upload.single("video"), async (req, res) => {
  const { videoId } = req.params;
  try {
    if (!req.file) return res.status(400).json({ error: "no file uploaded" });

    const video = await Video.findById(videoId);
    if (!video) return res.status(404).json({ error: "unknown videoId" });

    video.originalFileName = req.file.originalname;
    video.originalPath = req.file.path;
    video.sizeBytes = req.file.size;
    video.status = "processing";
    await video.save();
    await invalidateVideo(videoId);

    // Hand off to the transcoding pipeline via the message queue instead of
    // transcoding inline -- this is the decoupling from Figure 14-26.
    await enqueueTranscodeJob(videoId, req.file.path);

    res.json({ success: true, videoId, status: "processing" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "upload failed" });
  }
});

// ---- Flow b: update metadata (title/description) in parallel -------------
router.patch("/:videoId/metadata", async (req, res) => {
  try {
    const { title, description } = req.body;
    const video = await Video.findByIdAndUpdate(
      req.params.videoId,
      { $set: { ...(title && { title }), ...(description !== undefined && { description }) } },
      { new: true }
    );
    if (!video) return res.status(404).json({ error: "not found" });
    await invalidateVideo(video._id);
    res.json(video);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "metadata update failed" });
  }
});

module.exports = router;

\const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { v4: uuidv4 } = require("uuid");
const cloudinary = require("cloudinary").v2;

const Video = require("../models/Video");
const { enqueueTranscodeJob } = require("../queue");
const { invalidateVideo } = require("../cache");

const router = express.Router();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const ORIGINAL_DIR = path.resolve(
  __dirname,
  "../../",
  process.env.ORIGINAL_STORAGE_DIR || "../storage/original"
);
fs.mkdirSync(ORIGINAL_DIR, { recursive: true });

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

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ORIGINAL_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".mp4";
    cb(null, `${req.params.videoId}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 },
});

router.post("/upload/:videoId", upload.single("video"), async (req, res) => {
  const { videoId } = req.params;
  try {
    if (!req.file) return res.status(400).json({ error: "no file uploaded" });

    const video = await Video.findById(videoId);
    if (!video) return res.status(404).json({ error: "unknown videoId" });

    console.log(`[upload] uploading ${videoId} to Cloudinary...`);
    const cloudinaryResult = await cloudinary.uploader.upload(req.file.path, {
      resource_type: "video",
      public_id: `youtube-clone/${videoId}`,
    });

    // remove the temp local file now that it's safely in Cloudinary
    fs.unlink(req.file.path, () => {});

    video.originalFileName = req.file.originalname;
    video.originalPath = cloudinaryResult.secure_url;
    video.sizeBytes = req.file.size;
    video.status = "processing";
    await video.save();
    await invalidateVideo(videoId);

    await enqueueTranscodeJob(videoId, cloudinaryResult.secure_url);

    res.json({ success: true, videoId, status: "processing" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "upload failed" });
  }
});

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
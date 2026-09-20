const express = require("express");
const Video = require("../models/Video");
const {
  getCachedVideo,
  setCachedVideo,
  getCachedFeed,
  setCachedFeed,
  invalidateVideo,
} = require("../cache");

const router = express.Router();

// Home feed -- cache-aside: check Redis first, fall back to Mongo.
router.get("/", async (req, res) => {
  try {
    const cached = await getCachedFeed();
    if (cached) return res.json({ source: "cache", videos: cached });

    const videos = await Video.find({ status: "ready" })
      .sort({ createdAt: -1 })
      .limit(50);

    await setCachedFeed(videos);
    res.json({ source: "db", videos });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load feed" });
  }
});

// Single video metadata (watch page) -- also cache-aside.
router.get("/:id", async (req, res) => {
  try {
    const cached = await getCachedVideo(req.params.id);
    if (cached) return res.json({ source: "cache", video: cached });

    const video = await Video.findById(req.params.id);
    if (!video) return res.status(404).json({ error: "not found" });

    await setCachedVideo(video._id, video);
    res.json({ source: "db", video });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load video" });
  }
});

// Delete a video (removes the database record; does NOT delete files from
// Cloudinary -- those stay there but are simply no longer referenced).
router.delete("/:id", async (req, res) => {
  try {
    const video = await Video.findByIdAndDelete(req.params.id);
    if (!video) return res.status(404).json({ error: "not found" });

    await invalidateVideo(req.params.id);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to delete video" });
  }
});

module.exports = router;
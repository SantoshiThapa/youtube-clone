require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");

const { connectDB } = require("./db");
const uploadRoutes = require("./routes/upload");
const videoRoutes = require("./routes/videos");

const app = express();
app.use(cors());
app.use(express.json());

// Static file serving stands in for the CDN in this local setup:
// transcoded HLS playlists/segments and thumbnails are served straight
// from disk here. In production this folder would be your CDN origin.
const TRANSCODED_DIR = path.resolve(
  __dirname,
  "../../",
  process.env.TRANSCODED_STORAGE_DIR || "../storage/transcoded"
);
app.use("/cdn", express.static(TRANSCODED_DIR));

app.use("/api/videos", uploadRoutes);
app.use("/api/videos", videoRoutes);

app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;

connectDB()
  .then(() => {
    app.listen(PORT, () =>
      console.log(`[api-server] listening on http://localhost:${PORT}`)
    );
  })
  .catch((err) => {
    console.error("Failed to connect to MongoDB:", err.message);
    process.exit(1);
  });

const mongoose = require("mongoose");

// This is the "Metadata DB" schema from the book: title, size, resolution,
// format, user info, status, plus pointers to where the encoded outputs live.
const ResolutionSchema = new mongoose.Schema(
  {
    label: String, // e.g. "360p", "480p", "720p"
    playlistUrl: String, // path to that resolution's HLS playlist (.m3u8)
  },
  { _id: false }
);

const VideoSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => require("uuid").v4() },
    title: { type: String, default: "Untitled video" },
    description: { type: String, default: "" },
    originalFileName: String,
    originalPath: String, // path in "original storage" (blob storage)
    sizeBytes: Number,

    status: {
      type: String,
      enum: ["uploading", "processing", "ready", "failed"],
      default: "uploading",
    },

    thumbnailUrl: String,
    masterPlaylistUrl: String, // HLS master .m3u8 (adaptive bitrate)
    resolutions: [ResolutionSchema],

    uploader: { type: String, default: "anonymous" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Video", VideoSchema);
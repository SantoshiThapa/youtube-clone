const mongoose = require("mongoose");

async function connectDB() {
  const uri = process.env.MONGO_URI || "mongodb://localhost:27017/youtube_clone";
  await mongoose.connect(uri);
  console.log("[metadata-db] connected to MongoDB:", uri);
}

module.exports = { connectDB };

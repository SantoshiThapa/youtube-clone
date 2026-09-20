const Redis = require("ioredis");

// This plays the role of the book's "Metadata cache" component:
// video metadata is cached so repeated reads (home feed, watch page)
// don't have to hit MongoDB every time.
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

const TTL_SECONDS = 60; // short TTL so demo data doesn't feel "stuck"

async function getCachedVideo(id) {
  const raw = await redis.get(`video:${id}`);
  return raw ? JSON.parse(raw) : null;
}

async function setCachedVideo(id, video) {
  await redis.set(`video:${id}`, JSON.stringify(video), "EX", TTL_SECONDS);
}

async function invalidateVideo(id) {
  await redis.del(`video:${id}`);
  await redis.del("video:feed"); // home feed list is also stale now
}

async function getCachedFeed() {
  const raw = await redis.get("video:feed");
  return raw ? JSON.parse(raw) : null;
}

async function setCachedFeed(videos) {
  await redis.set("video:feed", JSON.stringify(videos), "EX", 15);
}

module.exports = {
  redis,
  getCachedVideo,
  setCachedVideo,
  invalidateVideo,
  getCachedFeed,
  setCachedFeed,
};

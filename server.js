import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import crypto from "crypto";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const JOBS_DIR = path.resolve("./jobs");
if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR, { recursive: true });

// ===================== HELPERS =====================
function logError(msg, err = null) {
  const logLine = `[${new Date().toISOString()}] ${msg} ${
    err ? JSON.stringify(err) : ""
  }\n`;
  console.error(logLine);
  fs.appendFileSync(path.join(JOBS_DIR, "errors.log"), logLine);
}

function sanitizeFileName(name) {
  return name.replace(/[^a-z0-9_\-\.]/gi, "_");
}

function encryptUrl(url) {
  const ENC_KEY = "CHANGE_THIS_TO_RANDOM_32_CHAR_SECRET_KEY_123456";
  const ENC_METHOD = "aes-256-cbc";
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ENC_METHOD, ENC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(url), cipher.final()]);
  return Buffer.concat([iv, encrypted]).toString("base64");
}

async function downloadSegment(url, dest) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = await res.arrayBuffer();
      fs.writeFileSync(dest, Buffer.from(buffer));
      return;
    } catch (err) {
      logError(`Segment download failed (${attempt}/3): ${url}`, err);
      if (attempt === 3) throw err;
    }
  }
}

function createConcatList(dir, total) {
  const listFile = path.join(dir, "list.txt");
  const content = Array.from({ length: total })
    .map((_, i) => `file '${path.join(dir, `${i}.ts`)}'`)
    .join("\n");
  fs.writeFileSync(listFile, content);
  return listFile;
}

function convertToMp4(listFile, output) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listFile,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      output,
    ]);

    ffmpeg.stderr.on("data", (d) => console.log(d.toString()));

    ffmpeg.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error("FFmpeg failed with code " + code));
    });
  });
}

// ===================== JOB MANAGEMENT =====================
const jobs = {};

function updateJob(id, data) {
  if (!jobs[id]) jobs[id] = {};
  Object.assign(jobs[id], data);
}

// ===================== ROUTES =====================

// 1️⃣ Submit job
app.post("/convert", async (req, res) => {
  try {
    const { episode_id } = req.body;
    if (!episode_id) return res.status(400).json({ error: "Missing episode_id" });

    const jobId = Date.now().toString();
    const jobDir = path.join(JOBS_DIR, sanitizeFileName(jobId));
    if (!fs.existsSync(jobDir)) fs.mkdirSync(jobDir, { recursive: true });

    const masterUrl = `https://kiroflix.cu.ma/generate/episodes/${episode_id}/master.m3u8`;

    updateJob(jobId, { id: jobId, status: "queued", progress: "0%", total: 0, downloaded: 0, file: null, m3u8: masterUrl });

    res.json({ id: jobId });

    // start processing asynchronously
    processJob(jobId, masterUrl, jobDir);
  } catch (err) {
    logError("Convert endpoint error", err);
    res.status(500).json({ error: "Server error" });
  }
});

// 2️⃣ Job progress
app.get("/progress/:id", (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

// ===================== JOB PROCESSING =====================
async function processJob(jobId, masterUrl, jobDir) {
  try {
    updateJob(jobId, { status: "downloading" });

    const masterRes = await fetch(masterUrl);
    if (!masterRes.ok) throw new Error("Master.m3u8 fetch failed");
    const masterText = await masterRes.text();
    const lines = masterText.split("\n").filter((l) => !l.startsWith("#EXT-X-I-FRAME"));

    // extract segments
    const segmentUrls = lines.filter((l) => l && !l.startsWith("#"));
    updateJob(jobId, { total: segmentUrls.length });

    // download segments
    let downloaded = 0;
    for (let i = 0; i < segmentUrls.length; i++) {
      const url = segmentUrls[i].startsWith("http")
        ? segmentUrls[i]
        : new URL(segmentUrls[i], masterUrl).href;
      const dest = path.join(jobDir, `${i}.ts`);
      await downloadSegment(url, dest);
      downloaded++;
      updateJob(jobId, { progress: `${Math.floor((downloaded / segmentUrls.length) * 100)}%`, downloaded });
    }

    // concat + convert
    const listFile = createConcatList(jobDir, segmentUrls.length);
    const outputFile = path.join(jobDir, "output.mp4");
    updateJob(jobId, { status: "converting" });

    await convertToMp4(listFile, outputFile);

    updateJob(jobId, { status: "done", progress: "100%", file: outputFile });
  } catch (err) {
    logError(`Job ${jobId} failed`, err);
    updateJob(jobId, { status: "error", progress: "100%", error: err.message });
  }
}

// ===================== START SERVER =====================
app.listen(PORT, () => {
  console.log(`HLS Converter server running on port ${PORT}`);
});

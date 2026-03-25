// server.js
import express from "express";
import { exec } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const TMP_DIR = path.join(__dirname, "tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

const jobs = {}; // store job progress & status

// ===== HELPER =====
function generateJobId() {
  return Date.now().toString() + Math.floor(Math.random() * 1000);
}

// ===== PROCESS JOB =====
function processJob(episode_id, jobId) {
  const jobDir = path.join(TMP_DIR, jobId);
  if (!fs.existsSync(jobDir)) fs.mkdirSync(jobDir);

  const outputFile = path.join(jobDir, "video.mp4");
  const masterUrl = `https://kiroflix.cu.ma/generate/episodes/${episode_id}/master.m3u8`;

  jobs[jobId] = {
    status: "processing",
    progress: 0,
    total: 0,
    downloaded: 0,
    file: null,
    m3u8: masterUrl,
    error: null,
  };

  // FFmpeg command using direct HLS URL
  const ffmpegCmd = `ffmpeg -y -protocol_whitelist file,http,https,tcp,tls -i "${masterUrl}" -c copy "${outputFile}"`;

  const ffmpegProc = exec(ffmpegCmd, (err, stdout, stderr) => {
    if (err) {
      console.error("FFmpeg error:", stderr);
      jobs[jobId].status = "error";
      jobs[jobId].progress = "100%";
      jobs[jobId].error = stderr;
      return;
    }
    jobs[jobId].status = "done";
    jobs[jobId].progress = "100%";
    jobs[jobId].file = outputFile;
  });

  // Optional: parse ffmpeg stderr for progress (rough)
  ffmpegProc.stderr.on("data", (data) => {
    const lines = data.toString().split("\n");
    lines.forEach((line) => {
      if (line.includes("frame=")) {
        // simple rough progress parsing
        jobs[jobId].progress = "processing";
      }
    });
  });
}

// ===== ROUTES =====

// START JOB
app.post("/convert", (req, res) => {
  const episode_id = req.body.episode_id;
  if (!episode_id) return res.json({ status: "error", error: "missing episode_id" });

  const jobId = generateJobId();
  processJob(episode_id, jobId);

  res.json({ status: "ok", job_id: jobId });
});

// CHECK PROGRESS
app.get("/progress/:jobId", (req, res) => {
  const jobId = req.params.jobId;
  if (!jobs[jobId]) return res.json({ status: "error", error: "invalid job_id" });

  res.json(jobs[jobId]);
});

// DOWNLOAD FILE
app.get("/download/:jobId", (req, res) => {
  const jobId = req.params.jobId;
  if (!jobs[jobId]) return res.json({ status: "error", error: "invalid job_id" });

  const job = jobs[jobId];
  if (job.status !== "done" || !fs.existsSync(job.file)) {
    return res.json({ status: "error", error: "file not ready" });
  }

  const filename = `video_${jobId}.mp4`;
  res.download(job.file, filename, (err) => {
    if (err) console.error("Download error:", err);
  });
});

// LISTEN
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`⚡ HLS Converter server running on port ${PORT}`));

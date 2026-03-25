import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// In-memory job store
const jobs = {}; // { jobId: { status, progress, total, downloaded, file, error } }

// ===== HELPERS =====
function generateJobId() {
  return Date.now().toString() + Math.floor(Math.random() * 10000);
}

async function fetchText(url) {
  const res = await fetch(url, { timeout: 120000 });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

async function downloadFile(url, dest) {
  const res = await fetch(url, { timeout: 120000 });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return new Promise((resolve, reject) => {
    const fileStream = fs.createWriteStream(dest);
    res.body.pipe(fileStream);
    res.body.on("error", reject);
    fileStream.on("finish", resolve);
  });
}

// ===== JOB WORKER =====
async function processJob(jobId, m3u8Url) {
  const job = jobs[jobId];
  try {
    job.status = "downloading";

    const tmpDir = path.join(__dirname, "tmp", jobId);
    fs.mkdirSync(tmpDir, { recursive: true });

    // Fetch master playlist
    const masterContent = await fetchText(m3u8Url);
    const lines = masterContent.split("\n");

    // Extract .ts segment URLs
    const segments = lines.filter(l => l.trim() && !l.startsWith("#"));
    job.total = segments.length;
    job.downloaded = 0;

    const localPlaylist = [];
    for (let i = 0; i < segments.length; i++) {
      const segUrl = segments[i].startsWith("http")
        ? segments[i]
        : new URL(segments[i], m3u8Url).href;

      const segName = `seg_${i}.ts`;
      const segPath = path.join(tmpDir, segName);

      await downloadFile(segUrl, segPath);
      localPlaylist.push(segName);

      job.downloaded = i + 1;
      job.progress = `${Math.floor(((i + 1) / segments.length) * 100)}%`;
    }

    // Save local playlist
    const localM3u8 = path.join(tmpDir, "local.m3u8");
    const m3u8Data = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-TARGETDURATION:10",
      "#EXT-X-MEDIA-SEQUENCE:0",
      ...localPlaylist.map(seg => `#EXTINF:10.0,\n${seg}`),
      "#EXT-X-ENDLIST"
    ].join("\n");
    fs.writeFileSync(localM3u8, m3u8Data);

    // Run FFmpeg to convert to MP4
    const outputFile = path.join(tmpDir, "video.mp4");
    await new Promise((resolve, reject) => {
      exec(
        `ffmpeg -y -protocol_whitelist file,http,https,tcp,tls -i "${localM3u8}" -c copy "${outputFile}"`,
        (err, stdout, stderr) => {
          if (err) return reject(new Error(stderr));
          resolve();
        }
      );
    });

    job.status = "done";
    job.file = outputFile;
    job.progress = "100%";
  } catch (err) {
    console.error("Job error:", err);
    job.status = "error";
    job.error = err.message;
  }
}

// ===== ROUTES =====

// Start job
app.get("/start", async (req, res) => {
  const { episode_id, m3u8 } = req.query;
  if (!episode_id || !m3u8) return res.json({ error: "Missing episode_id or m3u8" });

  const jobId = generateJobId();
  jobs[jobId] = {
    status: "queued",
    progress: "0%",
    total: 0,
    downloaded: 0,
    file: null,
    error: null
  };

  // Start worker asynchronously
  processJob(jobId, m3u8);

  res.json({ id: jobId, status: "queued" });
});

// Progress
app.get("/progress/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.json({ error: "Invalid jobId" });
  res.json(job);
});

// Download
app.get("/download/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.json({ error: "Invalid jobId" });
  if (job.status !== "done") return res.json({ error: "Job not finished" });

  res.download(job.file, `video_${req.params.jobId}.mp4`);
});

// Test route
app.get("/", (req, res) => {
  res.json({ message: "HLS Converter server running" });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

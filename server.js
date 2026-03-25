import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "500mb" })); // allow large POST payloads

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
async function processJob(jobId, episode_id) {
  const job = jobs[jobId];
  try {
    job.status = "downloading";

    // Generate master m3u8 from episode_id (like your PHP call)
    const m3u8Url = `https://kiroflix.cu.ma/generate/episodes/${episode_id}/master.m3u8`;

    const tmpDir = path.join(__dirname, "tmp", jobId);
    fs.mkdirSync(tmpDir, { recursive: true });

    const masterContent = await fetchText(m3u8Url);
    const lines = masterContent.split("\n");

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

    // Local playlist
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

    // Convert to MP4
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
    console.error(`Job ${jobId} error:`, err);
    job.status = "error";
    job.error = err.message;
  }
}

// ===== ROUTES =====

// POST /convert (from PHP start)
app.post("/convert", (req, res) => {
  const episode_id = req.body.episode_id;
  if (!episode_id) return res.json({ error: "missing episode_id" });

  const jobId = generateJobId();
  jobs[jobId] = {
    status: "queued",
    progress: "0%",
    total: 0,
    downloaded: 0,
    file: null,
    error: null
  };

  processJob(jobId, episode_id);

  res.json({ id: jobId, status: "queued" });
});

// GET /progress/:jobId
app.get("/progress/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.json({ error: "Invalid jobId" });
  res.json(job);
});

// GET /download/:jobId
app.get("/download/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.json({ error: "Invalid jobId" });
  if (job.status !== "done") return res.json({ error: "Job not finished" });

  res.download(job.file, `video_${req.params.jobId}.mp4`);
});

// Default
app.get("/", (req, res) => {
  res.json({ message: "HLS Converter server running" });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

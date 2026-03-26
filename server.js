import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { PassThrough } from "stream";
import https from "https";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const JOBS_DIR = path.resolve("./jobs");
if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR);

const jobs = {}; // jobId -> { status, progress, file, error }

// ===== LOGGING =====
function log(id, msg) {
  console.log(`[${id}] ${msg}`);
}

// ===== DOWNLOAD AND STREAM SEGMENTS =====
async function streamSegmentsToFFmpeg(playlistUrl, ffmpegStdin, id) {
  log(id, "📥 Fetch playlist");
  const playlistText = await (await fetch(playlistUrl, { agent: new https.Agent({ rejectUnauthorized: false }) })).text();
  const lines = playlistText.split("\n").filter(l => l && !l.startsWith("#"));

  const concurrency = 10;
  let completed = 0;

  async function fetchSegment(url) {
    const res = await fetch(url, { agent: new https.Agent({ rejectUnauthorized: false }) });
    if (!res.ok) throw new Error(`Segment HTTP ${res.status}`);
    return res.body;
  }

  async function downloadBatch(batch) {
    await Promise.all(batch.map(async url => {
      const segmentStream = await fetchSegment(url);
      await new Promise((resolve, reject) => {
        segmentStream.pipe(ffmpegStdin, { end: false });
        segmentStream.on("end", () => {
          completed++;
          jobs[id].progress = Math.floor((completed / lines.length) * 80) + "%";
          log(id, `📊 Progress: ${jobs[id].progress}`);
          resolve();
        });
        segmentStream.on("error", reject);
      });
    }));
  }

  for (let i = 0; i < lines.length; i += concurrency) {
    const batch = lines.slice(i, i + concurrency).map(l => l.startsWith("http") ? l : new URL(l, playlistUrl).href);
    await downloadBatch(batch);
  }
}

// ===== DOWNLOAD SUBTITLE =====
async function downloadSubtitle(episode_id, dir, id) {
  try {
    const url = `https://kiroflix.cu.ma/generate/episodes/${episode_id}/english.vtt`;
    const res = await fetch(url, { agent: new https.Agent({ rejectUnauthorized: false }) });
    if (!res.ok) return null;
    const subPath = path.join(dir, "subtitle.vtt");
    const stream = fs.createWriteStream(subPath);
    await new Promise((resolve, reject) => {
      res.body.pipe(stream);
      res.body.on("error", reject);
      stream.on("finish", resolve);
    });
    log(id, "📝 Subtitle downloaded");
    return subPath;
  } catch (err) {
    log(id, `⚠️ Subtitle fetch failed: ${err.message}`);
    return null;
  }
}

// ===== PROCESS JOB =====
async function processJob(id, episode_id, subtitle_mode = "hard") {
  try {
    const dir = path.join(JOBS_DIR, id);
    fs.mkdirSync(dir, { recursive: true });

    const masterUrl = `https://kiroflix.cu.ma/generate/episodes/${episode_id}/master.m3u8`;
    const masterText = await (await fetch(masterUrl, { agent: new https.Agent({ rejectUnauthorized: false }) })).text();
    const qualityLine = masterText.split("\n").find(l => l && !l.startsWith("#"));
    const playlistUrl = new URL(qualityLine, masterUrl).href;

    jobs[id] = { status: "processing", progress: "0%", file: null, error: null };

    const outputFile = path.join(dir, "output.mp4");

    const ffmpegArgs = [
      "-y",
      "-allowed_extensions", "ALL",
      "-protocol_whitelist", "file,http,https,tcp,tls",
      "-i", "pipe:0"
    ];

    // Subtitle options
    const subtitlePath = await downloadSubtitle(episode_id, dir, id);
    if (subtitlePath && subtitle_mode === "hard") {
      ffmpegArgs.push("-vf", `subtitles=${subtitlePath}`, "-c:v", "libx264", "-preset", "veryfast", "-c:a", "copy");
    } else {
      ffmpegArgs.push("-c", "copy");
    }

    if (subtitlePath && subtitle_mode === "soft") {
      ffmpegArgs.push("-i", subtitlePath, "-c:s", "mov_text", "-map", "0", "-map", "1");
    }

    ffmpegArgs.push(outputFile);

    const ffmpeg = spawn("ffmpeg", ffmpegArgs);
    const pass = new PassThrough();
    ffmpegStdin(pass);

    ffmpeg.stderr.on("data", d => console.log(`[${id}] FFmpeg: ${d.toString()}`));

    ffmpeg.on("close", code => {
      if (code === 0) {
        jobs[id].status = "done";
        jobs[id].file = outputFile;
        jobs[id].progress = "100%";
        log(id, "✅ Job complete");
      } else {
        jobs[id].status = "error";
        jobs[id].error = `FFmpeg exited ${code}`;
      }
    });

    // Start streaming segments to FFmpeg
    await streamSegmentsToFFmpeg(playlistUrl, pass, id);
    pass.end();

  } catch (err) {
    jobs[id].status = "error";
    jobs[id].error = err.message;
    log(id, `🔥 ERROR: ${err.message}`);
  }
}

// ===== ROUTES =====
app.post("/convert", (req, res) => {
  const { episode_id, subtitle_mode } = req.body;
  if (!episode_id) return res.json({ error: "missing episode_id" });

  const id = Date.now().toString();
  processJob(id, episode_id, subtitle_mode);
  res.json({ id });
});

app.get("/progress/:id", (req, res) => {
  res.json(jobs[req.params.id] || { error: "not found" });
});

app.get("/download/:id", (req, res) => {
  const job = jobs[req.params.id];
  if (!job || job.status !== "done") return res.json({ error: "not ready" });

  const filePath = job.file;
  if (!fs.existsSync(filePath)) return res.json({ error: "file missing" });

  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    "Content-Type": "video/mp4",
    "Content-Disposition": `attachment; filename="video_${req.params.id}.mp4"`,
    "Content-Length": stat.size,
    "Cache-Control": "no-cache"
  });

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);

  res.on("close", () => log(req.params.id, "⚠️ Client closed connection"));
  res.on("finish", () => log(req.params.id, "✅ Download finished"));
  stream.on("error", err => log(req.params.id, "❌ Stream error: " + err.message));
});

app.listen(PORT, () => console.log(`🚀 Node server running on port ${PORT}`));

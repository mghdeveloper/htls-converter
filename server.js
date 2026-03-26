import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const JOBS_DIR = path.resolve("./jobs");
if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR);

const jobs = {}; // jobId -> { status, progress, total, downloaded, file, error }

function log(id, msg) {
  console.log(`[${id}] ${msg}`);
}

// ===== DOWNLOAD SEGMENT =====
async function downloadSegment(url, dest, id, index) {
  try {
    const res = await fetch(url, { agent: new (await import("https")).Agent({ rejectUnauthorized: false }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const stream = fs.createWriteStream(dest);
    await new Promise((resolve, reject) => {
      res.body.pipe(stream);
      res.body.on("error", reject);
      stream.on("finish", resolve);
    });

    log(id, `✅ Segment ${index} done`);
  } catch (err) {
    log(id, `❌ Segment ${index} failed: ${err.message}`);
    throw err;
  }
}

// ===== PARALLEL DOWNLOAD =====
async function downloadSegmentsParallel(segments, id, concurrency = 50) {
  let completed = 0;
  const total = segments.length;

  async function worker(batch) {
    await Promise.all(batch.map(async seg => {
      await downloadSegment(seg.url, seg.file, id, seg.index);
      completed++;
      jobs[id].downloaded = completed;
      jobs[id].progress = Math.floor((completed / total) * 80) + "%"; // last 20% reserved for FFmpeg
    }));
  }

  for (let i = 0; i < segments.length; i += concurrency) {
    const batch = segments.slice(i, i + concurrency);
    await worker(batch);
  }
}

// ===== DOWNLOAD SUBTITLE =====
async function downloadSubtitle(episode_id, dir, id) {
  try {
    const url = `https://kiroflix.cu.ma/generate/episodes/${episode_id}/english.vtt`;
    const res = await fetch(url, { agent: new (await import("https")).Agent({ rejectUnauthorized: false }) });
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
    log(id, "📥 Fetch master.m3u8");

    const masterText = await (await fetch(masterUrl, { agent: new (await import("https")).Agent({ rejectUnauthorized: false }) })).text();
    const qualityLine = masterText.split("\n").find(l => l && !l.startsWith("#"));
    const playlistUrl = new URL(qualityLine, masterUrl).href;

    log(id, "📥 Fetch playlist");
    const playlistText = await (await fetch(playlistUrl, { agent: new (await import("https")).Agent({ rejectUnauthorized: false }) })).text();
    const lines = playlistText.split("\n");

    const segments = [];
    let segmentIndex = 0;
    let localPlaylist = "";

    for (const line of lines) {
      if (line.trim() && !line.startsWith("#")) {
        const segUrl = line.startsWith("http") ? line : new URL(line, playlistUrl).href;
        const localFile = path.join(dir, `${segmentIndex}.ts`);
        segments.push({ url: segUrl, file: localFile, index: segmentIndex });
        localPlaylist += `${segmentIndex}.ts\n`;
        segmentIndex++;
      } else {
        localPlaylist += line + "\n";
      }
    }

    fs.writeFileSync(path.join(dir, "local.m3u8"), localPlaylist);
    jobs[id].total = segments.length;
    log(id, `🎬 Total segments: ${segments.length}`);

    // ===== DOWNLOAD SEGMENTS PARALLEL =====
    await downloadSegmentsParallel(segments, id, 10);

    // ===== DOWNLOAD SUBTITLE =====
    const subtitlePath = await downloadSubtitle(episode_id, dir, id);

    // ===== FFMPEG MERGE =====
    const outputFile = path.join(dir, "output.mp4");
    await new Promise((resolve, reject) => {
      const ffArgs = [
        "-y",
        "-allowed_extensions", "ALL",
        "-protocol_whitelist", "file,http,https,tcp,tls",
        "-i", path.join(dir, "local.m3u8")
      ];

      // Hard subtitles
      if (subtitlePath && subtitle_mode === "hard") {
        ffArgs.push("-vf", `subtitles=${subtitlePath}`);
        ffArgs.push("-c:v", "libx264", "-preset", "veryfast", "-c:a", "copy");
      } else {
        ffArgs.push("-c", "copy");
      }

      // Soft subtitles
      if (subtitlePath && subtitle_mode === "soft") {
        ffArgs.push("-i", subtitlePath, "-c:s", "mov_text", "-map", "0", "-map", "1");
      }

      ffArgs.push(outputFile);

      const ff = spawn("ffmpeg", ffArgs);
      ff.stderr.on("data", d => console.log(`[${id}] FFmpeg: ${d.toString()}`));
      ff.on("close", code => {
        if (code === 0) resolve();
        else reject(new Error("FFmpeg failed"));
      });
    });

    jobs[id].status = "done";
    jobs[id].file = outputFile;
    jobs[id].progress = "100%";
    log(id, "✅ Job complete");

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
  jobs[id] = { status: "processing", progress: "0%", total: 0, downloaded: 0, file: null, error: null };
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

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

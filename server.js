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

const jobs = {};
const agent = new https.Agent({ rejectUnauthorized: false });

function log(id, msg) {
  console.log(`[${id}] ${msg}`);
}

// ===== GET PLAYLIST =====
async function getPlaylist(episode_id) {
  const masterUrl = `https://kiroflix.cu.ma/generate/episodes/${episode_id}/master.m3u8`;

  const master = await (await fetch(masterUrl, { agent })).text();
  const quality = master.split("\n").find(l => l && !l.startsWith("#"));

  return new URL(quality, masterUrl).href;
}

// ===== SAFE STREAM (NO MEMORY LEAK) =====
async function streamToFFmpeg(playlistUrl, pass, id) {
  const text = await (await fetch(playlistUrl, { agent })).text();
  const lines = text.split("\n").filter(l => l && !l.startsWith("#"));

  let done = 0;
  const total = lines.length;

  const concurrency = 10;
  let index = 0;

  async function worker() {
    while (true) {
      let i;

      // thread-safe index increment
      if (index >= lines.length) return;
      i = index++;

      const line = lines[i];
      const url = line.startsWith("http")
        ? line
        : new URL(line, playlistUrl).href;

      const res = await fetch(url, { agent });
      if (!res.ok) throw new Error(`Segment ${i} failed`);

      // ===== KEY FIX: sequential pipe per segment =====
      await new Promise((resolve, reject) => {
        res.body.on("error", reject);

        res.body.on("end", () => {
          done++;
          jobs[id].progress = Math.floor((done / total) * 85) + "%";
          resolve();
        });

        res.body.pipe(pass, { end: false });
      });
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
}

// ===== SUBTITLE =====
async function getSubtitle(episode_id, dir) {
  try {
    const url = `https://kiroflix.cu.ma/generate/episodes/${episode_id}/english.vtt`;
    const res = await fetch(url, { agent });
    if (!res.ok) return null;

    const file = path.join(dir, "sub.vtt");
    const stream = fs.createWriteStream(file);

    await new Promise((resolve, reject) => {
      res.body.pipe(stream);
      res.body.on("error", reject);
      stream.on("finish", resolve);
    });

    return file;
  } catch {
    return null;
  }
}

// ===== PROCESS =====
async function processJob(id, episode_id, subtitle_mode = "hard") {
  try {
    const dir = path.join(JOBS_DIR, id);
    fs.mkdirSync(dir, { recursive: true });

    jobs[id] = { status: "processing", progress: "0%", file: null };

    const playlistUrl = await getPlaylist(episode_id);
    const subtitle = await getSubtitle(episode_id, dir);

    const output = path.join(dir, "output.mp4");

    const args = [
      "-y",
      "-protocol_whitelist", "pipe,file,http,https,tcp,tls",
      "-i", "pipe:0"
    ];

    // ===== SUBTITLE =====
    if (subtitle && subtitle_mode === "hard") {
      args.push("-vf", `subtitles=${subtitle}`);
      args.push("-c:v", "libx264", "-preset", "veryfast", "-c:a", "copy");
    } else if (subtitle && subtitle_mode === "soft") {
      args.push("-i", subtitle, "-map", "0", "-map", "1");
      args.push("-c:v", "copy", "-c:a", "copy", "-c:s", "mov_text");
    } else {
      args.push("-c", "copy");
    }

    args.push(output);

    const ffmpeg = spawn("ffmpeg", args);
    const pass = new PassThrough();

    // optional safety (no warnings)
    pass.setMaxListeners(0);

    pass.pipe(ffmpeg.stdin);

    ffmpeg.stderr.on("data", () => {}); // keep silent

    ffmpeg.on("close", code => {
      if (code === 0) {
        jobs[id].status = "done";
        jobs[id].file = output;
        jobs[id].progress = "100%";
        log(id, "✅ DONE");
      } else {
        jobs[id].status = "error";
        jobs[id].error = "ffmpeg failed";
      }
    });

    await streamToFFmpeg(playlistUrl, pass, id);

    pass.end(); // VERY IMPORTANT

  } catch (e) {
    jobs[id].status = "error";
    jobs[id].error = e.message;
    log(id, e.message);
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

  const stat = fs.statSync(job.file);

  res.writeHead(200, {
    "Content-Type": "video/mp4",
    "Content-Length": stat.size,
    "Content-Disposition": `attachment; filename="video_${req.params.id}.mp4"`
  });

  fs.createReadStream(job.file).pipe(res);
});

app.listen(PORT, () => console.log("🚀 running", PORT));

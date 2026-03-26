import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const jobs = {};

function log(id, msg) {
  console.log(`[${id}] ${msg}`);
}

// ===== DOWNLOAD FILE (SEGMENTS + SUBS) =====
async function download(url, file, id, index = "") {
  try {
    log(id, `⬇️ Download ${index} start`);

    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const stream = fs.createWriteStream(file);

    await new Promise((resolve, reject) => {
      res.body.pipe(stream);

      res.body.on("error", reject);
      stream.on("finish", resolve);
      stream.on("error", reject);
    });

    log(id, `✅ Download ${index} done`);
  } catch (err) {
    log(id, `❌ Download ${index} failed: ${err.message}`);
    throw err;
  }
}

// ===== PROCESS JOB =====
async function processJob(id, episode_id) {
  try {
    const dir = `./tmp/${id}`;
    fs.mkdirSync(dir, { recursive: true });

    const masterUrl = `https://kiroflix.cu.ma/generate/episodes/${episode_id}/master.m3u8`;

    // ===== FETCH MASTER =====
    log(id, "📥 Fetch master.m3u8");
    const master = await (await fetch(masterUrl)).text();

    const quality = master.split("\n").find(l => l && !l.startsWith("#"));
    const playlistUrl = new URL(quality, masterUrl).href;

    // ===== FETCH PLAYLIST =====
    log(id, "📥 Fetch playlist");
    const playlist = await (await fetch(playlistUrl)).text();

    const lines = playlist.split("\n");

    let segmentIndex = 0;
    let newPlaylist = "";
    const segments = [];

    for (let line of lines) {
      if (line.trim() && !line.startsWith("#")) {
        const segUrl = line.startsWith("http")
          ? line
          : new URL(line, playlistUrl).href;

        const local = `${segmentIndex}.ts`;

        segments.push({
          url: segUrl,
          file: `${dir}/${local}`,
          index: segmentIndex
        });

        newPlaylist += local + "\n";
        segmentIndex++;
      } else {
        newPlaylist += line + "\n";
      }
    }

    jobs[id].total = segments.length;
    log(id, `🎬 Total segments: ${segments.length}`);

    // ===== DOWNLOAD SEGMENTS (SEQUENTIAL SAFE) =====
    let done = 0;

    for (let s of segments) {
      await download(s.url, s.file, id, s.index);

      done++;
      jobs[id].downloaded = done;
      jobs[id].progress = Math.floor((done / segments.length) * 100) + "%";

      log(id, `📊 Progress: ${jobs[id].progress}`);
    }

    // ===== SAVE LOCAL PLAYLIST =====
    const localM3U8 = `${dir}/local.m3u8`;
    fs.writeFileSync(localM3U8, newPlaylist);

    // ===== DOWNLOAD SUBTITLE =====
    const subtitleUrl = `https://kiroflix.cu.ma/generate/episodes/${episode_id}/english.vtt`;
    const subtitlePath = `${dir}/sub.vtt`;

    let hasSubtitle = true;

    try {
      log(id, "📥 Download subtitle");
      await download(subtitleUrl, subtitlePath, id, "SUB");
    } catch {
      hasSubtitle = false;
      log(id, "⚠️ Subtitle not available");
    }

    // ===== FFMPEG =====
    log(id, "🎥 Start FFmpeg");

    await new Promise((resolve, reject) => {
      const args = [
        "-y",
        "-allowed_extensions", "ALL",
        "-protocol_whitelist", "file,http,https,tcp,tls",
        "-i", localM3U8
      ];

      if (hasSubtitle && fs.existsSync(subtitlePath)) {
        args.push("-i", subtitlePath);

        args.push(
          "-map", "0:v",
          "-map", "0:a",
          "-map", "1:0",
          "-c", "copy",
          "-c:s", "mov_text",
          "-metadata:s:s:0", "language=eng",
          "-disposition:s:0", "default"
        );
      } else {
        args.push("-c", "copy");
      }

      args.push(`${dir}/output.mp4`);

      const ff = spawn("ffmpeg", args);

      ff.stderr.on("data", d => {
        console.log(`[${id}] FFmpeg: ${d.toString()}`);
      });

      ff.on("close", code => {
        if (code === 0) {
          log(id, "✅ FFmpeg done");
          resolve();
        } else {
          log(id, `❌ FFmpeg failed (${code})`);
          reject(new Error("FFmpeg failed"));
        }
      });
    });

    // ===== DONE =====
    jobs[id].status = "done";
    jobs[id].file = `${dir}/output.mp4`;
    jobs[id].progress = "100%";

  } catch (e) {
    log(id, `🔥 ERROR: ${e.message}`);
    jobs[id].status = "error";
    jobs[id].error = e.message;
  }
}

// ===== ROUTES =====

// START
app.post("/convert", (req, res) => {
  const id = Date.now().toString();
  const { episode_id } = req.body;

  jobs[id] = {
    status: "processing",
    progress: "0%",
    total: 0,
    downloaded: 0,
    file: null,
    error: null
  };

  processJob(id, episode_id);

  res.json({ id });
});

// PROGRESS
app.get("/progress/:id", (req, res) => {
  res.json(jobs[req.params.id] || { error: "not found" });
});

// DOWNLOAD
app.get("/download/:id", (req, res) => {
  const job = jobs[req.params.id];

  if (!job || job.status !== "done") {
    return res.json({ error: "not ready" });
  }

  const filePath = job.file;

  if (!fs.existsSync(filePath)) {
    return res.json({ error: "file missing" });
  }

  const stat = fs.statSync(filePath);

  log(req.params.id, `📤 Start download (${stat.size} bytes)`);

  res.writeHead(200, {
    "Content-Type": "video/mp4",
    "Content-Disposition": `attachment; filename="video_${req.params.id}.mp4"`,
    "Content-Length": stat.size,
    "Cache-Control": "no-cache"
  });

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);

  res.on("close", () => {
    log(req.params.id, "⚠️ Client closed connection");
  });

  res.on("finish", () => {
    log(req.params.id, "✅ Download finished");
  });

  stream.on("error", err => {
    log(req.params.id, "❌ Stream error: " + err.message);
  });
});

// ===== START SERVER =====
app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});

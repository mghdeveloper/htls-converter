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

// ===== DOWNLOAD FILE =====
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
async function processJob(id, episode_id, qualityHeight) {
  try {
    const dir = `./tmp/${id}`;
    fs.mkdirSync(dir, { recursive: true });

    const masterUrl = `https://kiroflix.cu.ma/generate/episodes/${episode_id}/master.m3u8`;

    log(id, "📥 Fetch master.m3u8");
    const master = await (await fetch(masterUrl)).text();

    // ===== PARSE VARIANTS =====
    const lines = master.split("\n");
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("#EXT-X-STREAM-INF")) {
        const info = lines[i];
        const url = lines[i + 1];
        const match = info.match(/RESOLUTION=\d+x(\d+)/);
        const height = match ? parseInt(match[1], 10) : null;
        variants.push({ info, url: new URL(url, masterUrl).href, height });
      }
    }

    // ===== SELECT QUALITY =====
    let selected = variants[0]; // fallback
    if (qualityHeight) {
      const found = variants.find(v => v.height === parseInt(qualityHeight, 10));
      if (found) selected = found;
    }
    log(id, `🎚 Selected quality: ${selected.height}px`);

    // ===== FETCH PLAYLIST =====
    log(id, "📥 Fetch playlist");
    const playlist = await (await fetch(selected.url)).text();
    const playlistLines = playlist.split("\n");

    let segmentIndex = 0;
    let newPlaylist = "";
    const segments = [];

    for (let line of playlistLines) {
      if (line.trim() && !line.startsWith("#")) {
        const segUrl = line.startsWith("http") ? line : new URL(line, selected.url).href;
        const local = `${segmentIndex}.ts`;
        segments.push({ url: segUrl, file: `${dir}/${local}`, index: segmentIndex });
        newPlaylist += local + "\n";
        segmentIndex++;
      } else {
        newPlaylist += line + "\n";
      }
    }

    jobs[id].total = segments.length;
    log(id, `🎬 Total segments: ${segments.length}`);

    // ===== PARALLEL DOWNLOAD =====
    const MAX_PARALLEL = 30;
    let done = 0;
    async function downloadSegment(s) {
      try {
        await download(s.url, s.file, id, s.index);
        done++;
        jobs[id].downloaded = done;
        jobs[id].progress = Math.floor((done / segments.length) * 100) + "%";
        log(id, `📊 Progress: ${jobs[id].progress}`);
      } catch (e) {
        log(id, `❌ Segment ${s.index} failed`);
        throw e;
      }
    }

    async function runInBatches(items, batchSize, fn) {
      for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        await Promise.allSettled(batch.map(fn));
      }
    }

    log(id, `⚡ Start parallel download with max ${MAX_PARALLEL}`);
    await runInBatches(segments, MAX_PARALLEL, downloadSegment);

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
      ff.stderr.on("data", d => console.log(`[${id}] FFmpeg: ${d.toString()}`));
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
app.post("/convert", (req, res) => {
  const id = Date.now().toString();
  const { episode_id, quality } = req.body;

  jobs[id] = {
    status: "processing",
    progress: "0%",
    total: 0,
    downloaded: 0,
    file: null,
    error: null
  };

  processJob(id, episode_id, quality);
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
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    const chunkSize = end - start + 1;
    const stream = fs.createReadStream(filePath, { start, end });

    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": "video/mp4",
      "Content-Disposition": `attachment; filename="video_${req.params.id}.mp4"`,
      "Cache-Control": "no-cache"
    });

    stream.pipe(res);
    stream.on("error", err => log(req.params.id, "❌ Stream error: " + err.message));
  } else {
    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": "video/mp4",
      "Content-Disposition": `attachment; filename="video_${req.params.id}.mp4"`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-cache"
    });
    fs.createReadStream(filePath).pipe(res);
  }

  res.on("close", () => log(req.params.id, "⚠️ Client closed connection"));
  res.on("finish", () => log(req.params.id, "✅ Download finished"));
});

app.listen(PORT, () => console.log("🚀 Server running on port", PORT));

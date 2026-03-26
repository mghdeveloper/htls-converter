import express from "express";
import fs from "fs";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import m3u8stream from "m3u8stream";
import { v4 as uuidv4 } from "uuid";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

const TMP_DIR = "./tmp";
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

const jobs = {};

// ===== HELPER =====
function getOutputPath(jobId) {
  const dir = path.join(TMP_DIR, jobId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  return path.join(dir, "output.mp4");
}

// ===== START CONVERT =====
app.post("/convert", async (req, res) => {
  const { url, quality = "high", subtitle = false, subtitle_mode = "hard", subtitle_url } = req.body;

  if (!url) return res.status(400).json({ error: "missing url" });

  const jobId = uuidv4();
  const output = getOutputPath(jobId);

  jobs[jobId] = { status: "processing", progress: 0, size: 0, file: output };

  console.log(`[${jobId}] 🚀 Start job`);

  try {
    const stream = m3u8stream(url, { maxRetries: 5, retryDelay: 2000 });

    let command = ffmpeg(stream);

    // ===== QUALITY PRESETS =====
    switch (quality) {
      case "high":
        command.videoCodec("libx264").audioCodec("aac").outputOptions(["-preset veryfast", "-crf 22"]);
        break;
      case "medium":
        command.videoCodec("libx264").audioCodec("aac").outputOptions(["-preset fast", "-crf 25"]);
        break;
      case "low":
        command.videoCodec("libx264").audioCodec("aac").outputOptions(["-preset ultrafast", "-crf 28"]);
        break;
      case "copy":
        command.outputOptions(["-c copy", "-bsf:a aac_adtstoasc"]);
        break;
      default:
        command.videoCodec("libx264").audioCodec("aac").outputOptions(["-preset veryfast", "-crf 22"]);
    }

    // ===== SUBTITLES =====
    if (subtitle && subtitle_mode === "hard" && subtitle_url) {
      const subPath = path.join(TMP_DIR, jobId, "sub.srt");

      // download subtitle file first
      const subData = await fetch(subtitle_url).then((r) => r.text());
      fs.writeFileSync(subPath, subData);

      command.outputOptions([`-vf subtitles=${subPath}`]);
    }

    command
      .on("progress", (p) => {
        jobs[jobId].progress = Math.floor(p.percent || 0);
        if (fs.existsSync(output)) jobs[jobId].size = fs.statSync(output).size;
      })
      .on("end", () => {
        jobs[jobId].status = "done";
        console.log(`[${jobId}] ✅ Done`);
      })
      .on("error", (err) => {
        jobs[jobId].status = "error";
        console.log(`[${jobId}] ❌ Error: ${err.message}`);
      })
      .save(output);

    res.json({ job_id: jobId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ===== PROGRESS =====
app.get("/progress/:id", (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: "not found" });

  const sizeMB = (job.size / 1024 / 1024).toFixed(2);
  const sizeGB = (job.size / 1024 / 1024 / 1024).toFixed(2);

  res.json({ status: job.status, progress: job.progress, size_bytes: job.size, size_mb: sizeMB, size_gb: sizeGB });
});

// ===== DOWNLOAD =====
app.get("/download/:id", (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: "not found" });
  if (job.status !== "done") return res.status(400).json({ error: "not ready", progress: job.progress });

  const stat = fs.statSync(job.file);
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Length", stat.size);
  res.setHeader("Content-Disposition", `attachment; filename="video_${req.params.id}.mp4"`);
  fs.createReadStream(job.file).pipe(res);
});

// ===== CLEANUP =====
app.get("/cleanup/:id", (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: "not found" });

  try {
    fs.rmSync(path.dirname(job.file), { recursive: true, force: true });
    delete jobs[req.params.id];
    res.json({ status: "deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`🚀 HLS Converter running on port ${PORT}`));

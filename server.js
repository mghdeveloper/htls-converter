import express from "express";
import m3u8stream from "m3u8stream";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const JOBS_DIR = path.resolve("./jobs");
if (!fs.existsSync(JOBS_DIR)) fs.mkdirSync(JOBS_DIR);

const jobs = {}; // { jobId: { progress, filepath, status } }

// ===== Start conversion =====
app.post("/convert", async (req, res) => {
  const { episode_id, quality = "high", subtitle = false, subtitle_mode = "hard" } = req.body;

  if (!episode_id) return res.json({ error: "missing episode_id" });

  const jobId = uuidv4();
  const outFile = path.join(JOBS_DIR, `${jobId}.mp4`);

  jobs[jobId] = { progress: 0, filepath: outFile, status: "processing" };

  // Example: map episode_id + quality to m3u8 URL
  const m3u8Url = `https://example.com/episodes/${episode_id}/${quality}.m3u8`;
  let subtitlePath = null;

  if (subtitle) {
    // Download subtitle file if exists
    try {
      const subRes = await fetch(`https://example.com/episodes/${episode_id}.srt`);
      if (subRes.ok) {
        subtitlePath = path.join(JOBS_DIR, `${jobId}.srt`);
        const fileStream = fs.createWriteStream(subtitlePath);
        await new Promise((resolve, reject) => {
          subRes.body.pipe(fileStream);
          subRes.body.on("error", reject);
          fileStream.on("finish", resolve);
        });
      }
    } catch (err) {
      console.log("Subtitle fetch failed:", err.message);
    }
  }

  // Stream HLS and convert
  const stream = m3u8stream(m3u8Url);

  ffmpeg(stream)
    .outputOptions("-c:v libx264", "-preset veryfast", "-c:a aac")
    .on("progress", (p) => {
      jobs[jobId].progress = p.percent ? Math.round(p.percent) : jobs[jobId].progress;
    })
    .on("end", () => {
      jobs[jobId].progress = 100;
      jobs[jobId].status = "done";
      // If hard subtitles, burn subtitles into video
      if (subtitle && subtitle_mode === "hard" && subtitlePath) {
        const tmpFile = outFile.replace(".mp4", "_sub.mp4");
        ffmpeg(outFile)
          .input(subtitlePath)
          .outputOptions("-c:v libx264", "-preset veryfast", "-c:a copy", "-vf subtitles=" + subtitlePath)
          .save(tmpFile)
          .on("end", () => {
            fs.renameSync(tmpFile, outFile);
          });
      }
    })
    .on("error", (err) => {
      console.log("Conversion error:", err.message);
      jobs[jobId].status = "error";
    })
    .save(outFile);

  res.json({ job_id: jobId, status: "started" });
});

// ===== Progress route =====
app.get("/progress/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.json({ error: "job not found" });
  res.json({ job_id: req.params.jobId, progress: job.progress, status: job.status });
});

// ===== Download route =====
app.get("/download/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || !fs.existsSync(job.filepath)) return res.status(404).json({ error: "file not ready" });

  res.download(job.filepath, `video_${req.params.jobId}.mp4`);
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

import express from "express";
import fs from "fs";
import path from "path";
import m3u8stream from "m3u8stream";
import ffmpeg from "fluent-ffmpeg";
import { v4 as uuidv4 } from "uuid";

const app = express();
const PORT = 3000;

const DOWNLOAD_DIR = path.join(process.cwd(), "downloads");
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

let jobs = {}; // jobId => { status, progress, file, mode }

app.use(express.json());

// ======= Create Job =======
app.post("/download", async (req, res) => {
  const { url, subtitles, fastMode } = req.body;
  if (!url) return res.status(400).json({ error: "Missing url" });

  const jobId = uuidv4();
  const outFile = path.join(DOWNLOAD_DIR, `${jobId}.mp4`);

  jobs[jobId] = { status: "processing", progress: 0, file: outFile, mode: fastMode ? "fast" : "subtitles" };

  // ===== Start ffmpeg processing =====
  const inputStream = m3u8stream(url);

  let ffmpegCommand = ffmpeg(inputStream)
    .outputOptions([
      "-movflags frag_keyframe+empty_moov", // allows partial download if needed
    ]);

  if (subtitles && !fastMode) {
    ffmpegCommand = ffmpegCommand.videoCodec("libx264").audioCodec("aac").outputOptions([
      `-vf subtitles=${subtitles}`,
      "-preset veryfast",
      "-crf 22",
    ]);
  } else {
    // fast copy mode (no re-encode)
    ffmpegCommand = ffmpegCommand.outputOptions(["-c copy"]);
  }

  ffmpegCommand
    .on("progress", (p) => {
      jobs[jobId].progress = Math.floor(p.percent || 0);
      // console.log(jobId, jobs[jobId].progress);
    })
    .on("end", () => {
      jobs[jobId].status = "done";
      console.log(`✅ Job ${jobId} finished`);
    })
    .on("error", (err) => {
      jobs[jobId].status = "error";
      console.error(`❌ Job ${jobId} failed:`, err.message);
    })
    .save(outFile);

  res.json({ jobId, status: "processing" });
});

// ======= Check Progress =======
app.get("/progress/:id", (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({ status: job.status, progress: job.progress });
});

// ======= Download File =======
app.get("/download/:id", (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.status !== "done") return res.status(400).json({ error: "File not ready", progress: job.progress });

  const stat = fs.statSync(job.file);
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Length", stat.size);
  res.setHeader("Content-Disposition", `attachment; filename="video_${req.params.id}.mp4"`);

  fs.createReadStream(job.file).pipe(res);
});

app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));

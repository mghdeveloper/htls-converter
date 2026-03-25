import express from "express";
import fetch from "node-fetch";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

const app = express();
const PORT = process.env.PORT || 3000;

// ====== CONFIG ======
const JOB_DIR = "./jobs";
const VIDEO_DIR = "./videos";
const MAX_CONCURRENT = 2;

// ====== INIT ======
if (!fs.existsSync(JOB_DIR)) fs.mkdirSync(JOB_DIR);
if (!fs.existsSync(VIDEO_DIR)) fs.mkdirSync(VIDEO_DIR);

let activeJobs = 0;
const queue = [];

// ====== HELPERS ======
function createJob(data) {
    const id = Date.now().toString();

    const job = {
        id,
        status: "queued",
        progress: "0%",
        m3u8: data.m3u8,
        file: null
    };

    fs.writeFileSync(`${JOB_DIR}/${id}.json`, JSON.stringify(job));
    return job;
}

function updateJob(id, updates) {
    const file = `${JOB_DIR}/${id}.json`;
    if (!fs.existsSync(file)) return;

    const job = JSON.parse(fs.readFileSync(file));
    Object.assign(job, updates);

    fs.writeFileSync(file, JSON.stringify(job));
}

function getJob(id) {
    const file = `${JOB_DIR}/${id}.json`;
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file));
}

// ====== FETCH SOURCE ======
async function getSource(episodeId) {
    const res = await fetch(`https://kiroflix.site/api/getsources-v2.php?episode_id=${episodeId}`);
    const data = await res.json();

    return data.primary?.sources?.[0]?.file ||
           data.secondary?.sources?.[0]?.file;
}

// ====== WORKER ======
function runFFmpeg(job) {
    const output = `${VIDEO_DIR}/${job.id}.mp4`;

    updateJob(job.id, { status: "processing" });

    const ffmpeg = spawn("ffmpeg", [
        "-user_agent", "Mozilla/5.0",
        "-headers", "Referer: https://megacloud.blog\r\nOrigin: https://megacloud.blog",
        "-i", job.m3u8,
        "-c", "copy",
        "-bsf:a", "aac_adtstoasc",
        "-movflags", "+faststart",
        output
    ]);

    ffmpeg.stderr.on("data", (data) => {
        const text = data.toString();

        // crude progress detection
        const match = text.match(/time=(\d+:\d+:\d+)/);
        if (match) {
            updateJob(job.id, { progress: match[1] });
        }
    });

    ffmpeg.on("close", (code) => {
        activeJobs--;

        if (code === 0) {
            updateJob(job.id, {
                status: "done",
                file: output,
                progress: "100%"
            });
        } else {
            updateJob(job.id, { status: "error" });
        }

        processQueue(); // next job
    });
}

// ====== QUEUE SYSTEM ======
function processQueue() {
    if (activeJobs >= MAX_CONCURRENT || queue.length === 0) return;

    const job = queue.shift();
    activeJobs++;
    runFFmpeg(job);
}

// ====== ROUTES ======

// 🎬 Start job
app.get("/start", async (req, res) => {
    const { episode_id } = req.query;

    if (!episode_id) {
        return res.json({ error: "missing episode_id" });
    }

    try {
        const m3u8 = await getSource(episode_id);

        if (!m3u8) {
            return res.json({ error: "no source found" });
        }

        const job = createJob({ m3u8 });

        queue.push(job);
        processQueue();

        res.json({ job_id: job.id });

    } catch (err) {
        res.json({ error: "failed to start job" });
    }
});

// 📊 Progress
app.get("/progress/:id", (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.sendStatus(404);
    res.json(job);
});

// 📥 Download
app.get("/download/:id", (req, res) => {
    const job = getJob(req.params.id);

    if (!job || job.status !== "done") {
        return res.json({ error: "not ready" });
    }

    res.download(job.file);
});

// 🧹 Cleanup old jobs (optional)
setInterval(() => {
    const files = fs.readdirSync(JOB_DIR);

    files.forEach(file => {
        const filePath = path.join(JOB_DIR, file);
        const job = JSON.parse(fs.readFileSync(filePath));

        // delete jobs older than 1 hour
        if (Date.now() - parseInt(job.id) > 3600000) {
            fs.unlinkSync(filePath);
            if (job.file && fs.existsSync(job.file)) {
                fs.unlinkSync(job.file);
            }
        }
    });
}, 600000);

// ====== START ======
app.listen(PORT, () => {
    console.log("Server running on port", PORT);
});

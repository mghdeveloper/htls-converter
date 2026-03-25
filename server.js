import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CONFIG =====
const JOB_DIR = "./jobs";
const VIDEO_DIR = "./videos";
const TEMP_DIR = "./temp";
const MAX_CONCURRENT = 2;
const SEGMENT_CONCURRENCY = 30;

if (!fs.existsSync(JOB_DIR)) fs.mkdirSync(JOB_DIR);
if (!fs.existsSync(VIDEO_DIR)) fs.mkdirSync(VIDEO_DIR);
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

let activeJobs = 0;
const queue = [];

// ===== HEADERS (IMPORTANT) =====
const HEADERS = {
    "User-Agent": "Mozilla/5.0",
    "Referer": "https://megacloud.blog/",
    "Origin": "https://megacloud.blog"
};

// ===== JOB SYSTEM =====
function createJob(data) {
    const id = Date.now().toString();
    const job = {
        id,
        status: "queued",
        progress: 0,
        total: 0,
        downloaded: 0,
        file: null,
        ...data
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

// ===== FETCH SOURCE =====
async function getSource(episodeId) {
    const res = await fetch(`https://kiroflix.site/api/getsources-v2.php?episode_id=${episodeId}`);
    const data = await res.json();

    return data.primary?.sources?.[0]?.file ||
           data.secondary?.sources?.[0]?.file;
}

// ===== PARSE M3U8 =====
async function parseM3U8(url) {
    const res = await fetch(url, { headers: HEADERS });
    const text = await res.text();

    const lines = text.split("\n");
    const base = url.substring(0, url.lastIndexOf("/") + 1);

    // detect variant playlist
    const variant = lines.find(l => l && !l.startsWith("#") && l.includes(".m3u8"));
    if (variant) {
        const newUrl = variant.startsWith("http") ? variant : base + variant;
        return parseM3U8(newUrl);
    }

    // segments
    const segments = lines
        .filter(l => l && !l.startsWith("#"))
        .map(l => l.startsWith("http") ? l : base + l);

    return segments;
}

// ===== DOWNLOAD SEGMENTS =====
async function downloadSegments(job, segments) {
    const dir = `${TEMP_DIR}/${job.id}`;
    fs.mkdirSync(dir, { recursive: true });

    updateJob(job.id, { total: segments.length });

    let index = 0;

    async function worker() {
        while (index < segments.length) {
            const i = index++;
            const url = segments[i];

            for (let retry = 0; retry < 3; retry++) {
                try {
                    const res = await fetch(url, { headers: HEADERS });
                    const buffer = await res.buffer();

                    fs.writeFileSync(`${dir}/${i}.ts`, buffer);

                    updateJob(job.id, {
                        downloaded: i + 1,
                        progress: Math.floor(((i + 1) / segments.length) * 100)
                    });

                    break;
                } catch {}
            }
        }
    }

    const workers = Array.from({ length: SEGMENT_CONCURRENCY }, worker);
    await Promise.all(workers);

    return dir;
}

// ===== MERGE TS =====
async function mergeTS(job, dir, count) {
    const outputTS = `${dir}/output.ts`;
    const write = fs.createWriteStream(outputTS);

    for (let i = 0; i < count; i++) {
        const file = `${dir}/${i}.ts`;
        if (fs.existsSync(file)) {
            const data = fs.readFileSync(file);
            write.write(data);
        }
    }

    write.end();
    return outputTS;
}

// ===== CONVERT TO MP4 =====
function convertToMp4(input, output, jobId) {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn("ffmpeg", [
            "-i", input,
            "-c", "copy",
            "-movflags", "+faststart",
            output
        ]);

        ffmpeg.on("close", code => {
            if (code === 0) resolve();
            else reject();
        });
    });
}

// ===== PROCESS JOB =====
async function processJob(job) {
    try {
        updateJob(job.id, { status: "processing" });

        const segments = await parseM3U8(job.m3u8);

        const dir = await downloadSegments(job, segments);

        const tsFile = await mergeTS(job, dir, segments.length);

        const output = `${VIDEO_DIR}/${job.id}.mp4`;

        await convertToMp4(tsFile, output, job.id);

        updateJob(job.id, {
            status: "done",
            file: output,
            progress: 100
        });

    } catch (err) {
        updateJob(job.id, { status: "error" });
    }

    activeJobs--;
    processQueue();
}

// ===== QUEUE =====
function processQueue() {
    if (activeJobs >= MAX_CONCURRENT || queue.length === 0) return;

    const job = queue.shift();
    activeJobs++;
    processJob(job);
}

// ===== ROUTES =====

// start
app.get("/start", async (req, res) => {
    const { episode_id } = req.query;
    if (!episode_id) return res.json({ error: "missing episode_id" });

    try {
        const m3u8 = await getSource(episode_id);
        const job = createJob({ m3u8 });

        queue.push(job);
        processQueue();

        res.json({ job_id: job.id });

    } catch {
        res.json({ error: "failed" });
    }
});

// progress
app.get("/progress/:id", (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.sendStatus(404);
    res.json(job);
});

// download
app.get("/download/:id", (req, res) => {
    const job = getJob(req.params.id);
    if (!job || job.status !== "done") return res.json({ error: "not ready" });

    res.download(job.file);
});

// ===== START =====
app.listen(PORT, () => {
    console.log("Server running on", PORT);
});

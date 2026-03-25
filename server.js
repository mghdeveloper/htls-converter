import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CONFIG =====
const BASE_API = "https://kiroflix.cu.ma/generate/generate_episode.php";
const BASE_FILES = "https://kiroflix.cu.ma/generate/";

const JOB_DIR = "./jobs";
const VIDEO_DIR = "./videos";
const TEMP_DIR = "./temp";

const MAX_CONCURRENT = 2;
const SEGMENT_CONCURRENCY = 10;

[JOB_DIR, VIDEO_DIR, TEMP_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d);
});

let activeJobs = 0;
const queue = [];

// ===== HEADERS =====
const HEADERS = {
    "User-Agent": "Mozilla/5.0"
};

// ===== JOB =====
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

// ===== GET M3U8 FROM YOUR PHP =====
async function getMaster(episodeId) {
    const res = await fetch(`${BASE_API}?episode_id=${episodeId}`);
    const data = await res.json();

    if (!data.success) throw new Error("API failed");

    return BASE_FILES + data.master.replace(/\\/g, "");
}

// ===== PARSE M3U8 =====
async function parseM3U8(url) {
    const res = await fetch(url, { headers: HEADERS });
    const text = await res.text();

    const lines = text.split("\n");
    const base = url.substring(0, url.lastIndexOf("/") + 1);

    // variant playlist
    const variant = lines.find(l => l && !l.startsWith("#") && l.includes(".m3u8"));
    if (variant) {
        const next = variant.startsWith("http") ? variant : base + variant;
        return parseM3U8(next);
    }

    return lines
        .filter(l => l && !l.startsWith("#"))
        .map(l => l.startsWith("http") ? l : base + l);
}

// ===== DOWNLOAD =====
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
                    const buffer = Buffer.from(await res.arrayBuffer());

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

    await Promise.all(
        Array.from({ length: SEGMENT_CONCURRENCY }, worker)
    );

    return dir;
}

// ===== MERGE =====
async function mergeTS(dir, count) {
    const output = `${dir}/merged.ts`;
    const write = fs.createWriteStream(output);

    for (let i = 0; i < count; i++) {
        const file = `${dir}/${i}.ts`;
        if (fs.existsSync(file)) {
            write.write(fs.readFileSync(file));
        }
    }

    write.end();
    return output;
}

// ===== CONVERT =====
function convertToMp4(input, output) {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn("ffmpeg", [
            "-i", input,
            "-c", "copy",
            "-movflags", "+faststart",
            output
        ]);

        ffmpeg.on("close", code => {
            code === 0 ? resolve() : reject();
        });
    });
}

// ===== PROCESS =====
async function processJob(job) {
    try {
        updateJob(job.id, { status: "processing" });

        const segments = await parseM3U8(job.m3u8);

        const dir = await downloadSegments(job, segments);

        const ts = await mergeTS(dir, segments.length);

        const output = `${VIDEO_DIR}/${job.id}.mp4`;

        await convertToMp4(ts, output);

        updateJob(job.id, {
            status: "done",
            file: output,
            progress: 100
        });

    } catch (e) {
        console.error(e);
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
app.get("/start", async (req, res) => {
    const { episode_id } = req.query;

    try {
        const m3u8 = await getMaster(episode_id);

        const job = createJob({ m3u8 });

        queue.push(job);
        processQueue();

        res.json({ job_id: job.id });

    } catch {
        res.json({ error: "failed" });
    }
});

app.get("/progress/:id", (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.sendStatus(404);
    res.json(job);
});

app.get("/download/:id", (req, res) => {
    const job = getJob(req.params.id);
    if (!job || job.status !== "done") {
        return res.json({ error: "not ready" });
    }
    res.download(job.file);
});

app.listen(PORT, () => {
    console.log("Server running on", PORT);
});

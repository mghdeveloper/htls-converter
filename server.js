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

// ===== DOWNLOAD SEGMENT =====
async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed segment");

  const stream = fs.createWriteStream(file);
  await new Promise((resolve, reject) => {
    res.body.pipe(stream);
    res.body.on("error", reject);
    stream.on("finish", resolve);
  });
}

// ===== PROCESS JOB =====
async function processJob(id, episode_id) {
  try {
    const dir = `./tmp/${id}`;
    fs.mkdirSync(dir, { recursive: true });

    const masterUrl = `https://kiroflix.cu.ma/generate/episodes/${episode_id}/master.m3u8`;

    log(id, "fetch master");
    const master = await (await fetch(masterUrl)).text();

    const quality = master.split("\n").find(l => l && !l.startsWith("#"));
    const playlistUrl = new URL(quality, masterUrl).href;

    log(id, "fetch playlist");
    const playlist = await (await fetch(playlistUrl)).text();

    const lines = playlist.split("\n");

    let segmentIndex = 0;
    let newPlaylist = "";

    const segments = [];

    // ===== PARSE PLAYLIST =====
    for (let line of lines) {
      if (line.trim() && !line.startsWith("#")) {
        const segUrl = line.startsWith("http")
          ? line
          : new URL(line, playlistUrl).href;

        const local = `${segmentIndex}.ts`;
        segments.push({ url: segUrl, file: `${dir}/${local}` });

        newPlaylist += local + "\n";
        segmentIndex++;
      } else {
        newPlaylist += line + "\n";
      }
    }

    jobs[id].total = segments.length;

    // ===== DOWNLOAD ALL SEGMENTS =====
    let done = 0;
    for (let s of segments) {
      await download(s.url, s.file);
      done++;
      jobs[id].downloaded = done;
      jobs[id].progress = Math.floor((done / segments.length) * 100) + "%";
    }

    // ===== SAVE PLAYLIST =====
    const localM3U8 = `${dir}/local.m3u8`;
    fs.writeFileSync(localM3U8, newPlaylist);

    // ===== FFMPEG =====
    log(id, "ffmpeg start");

    await new Promise((resolve, reject) => {
      const ff = spawn("ffmpeg", [
        "-y",
        "-allowed_extensions", "ALL",
        "-protocol_whitelist", "file,http,https,tcp,tls",
        "-i", localM3U8,
        "-c", "copy",
        `${dir}/output.mp4`
      ]);

      ff.stderr.on("data", d => console.log(d.toString()));

      ff.on("close", code => {
        code === 0 ? resolve() : reject(new Error("ffmpeg failed"));
      });
    });

    jobs[id].status = "done";
    jobs[id].file = `${dir}/output.mp4`;
    jobs[id].progress = "100%";

  } catch (e) {
    jobs[id].status = "error";
    jobs[id].error = e.message;
    console.log("ERROR:", e);
  }
}

// ===== ROUTES =====

// KEEP SAME FOR PHP
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

app.get("/progress/:id", (req, res) => {
  res.json(jobs[req.params.id] || { error: "not found" });
});

app.get("/download/:id", (req, res) => {
  const job = jobs[req.params.id];
  if (!job || job.status !== "done") {
    return res.json({ error: "not ready" });
  }
  res.download(job.file);
});

app.listen(PORT, () => console.log("Server running", PORT));

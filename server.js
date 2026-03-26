import express from "express";
import fetch from "node-fetch";
import fs from "fs";
import { spawn } from "child_process";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const jobs = {};

function log(id, msg) {
  console.log(`[${id}] ${msg}`);
}

function formatSize(bytes) {
  if (!bytes) return null;
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) return gb.toFixed(2) + " GB";
  return (bytes / (1024 ** 2)).toFixed(2) + " MB";
}

// ===== DOWNLOAD SEGMENT =====
async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("Segment failed");

  const stream = fs.createWriteStream(file);

  await new Promise((resolve, reject) => {
    res.body.pipe(stream);
    res.body.on("error", reject);
    stream.on("finish", resolve);
  });
}

// ===== PROCESS =====
async function processJob(id, episode_id, quality, subtitle, subtitle_mode) {
  try {
    const dir = `./tmp/${id}`;
    fs.mkdirSync(dir, { recursive: true });

    const masterUrl = `https://kiroflix.cu.ma/generate/episodes/${episode_id}/master.m3u8`;

    log(id, "Fetch master");
    const master = await (await fetch(masterUrl)).text();

    const playlists = master.split("\n").filter(l => l && !l.startsWith("#"));

    let selected;
    if (quality === "low") selected = playlists.at(-1);
    else if (quality === "medium") selected = playlists[Math.floor(playlists.length / 2)];
    else selected = playlists[0];

    const playlistUrl = new URL(selected, masterUrl).href;

    log(id, "Fetch playlist");
    const playlist = await (await fetch(playlistUrl)).text();

    const lines = playlist.split("\n");

    let newPlaylist = "";
    let segments = [];
    let i = 0;

    for (let line of lines) {
      if (line.trim() && !line.startsWith("#")) {
        const url = line.startsWith("http") ? line : new URL(line, playlistUrl).href;

        segments.push({ url, file: `${dir}/${i}.ts` });
        newPlaylist += `${i}.ts\n`;
        i++;
      } else {
        newPlaylist += line + "\n";
      }
    }

    jobs[id].total = segments.length;

    let done = 0;
    for (let s of segments) {
      await download(s.url, s.file);
      done++;
      jobs[id].downloaded = done;
      jobs[id].progress = Math.floor((done / segments.length) * 100) + "%";
    }

    const localM3U8 = `${dir}/local.m3u8`;
    fs.writeFileSync(localM3U8, newPlaylist);

    // ===== SUBTITLE =====
    let subtitleFile = null;

    if (subtitle) {
      try {
        const vttUrl = `https://kiroflix.cu.ma/generate/episodes/${episode_id}/english.vtt`;
        const vtt = await (await fetch(vttUrl)).text();

        subtitleFile = `${dir}/sub.vtt`;
        fs.writeFileSync(subtitleFile, vtt);

        log(id, "Subtitle downloaded");
      } catch {
        log(id, "No subtitle found");
      }
    }

    // ===== FFMPEG =====
    const output = `${dir}/output.mp4`;

    let ffArgs = [
      "-y",
      "-allowed_extensions", "ALL",
      "-protocol_whitelist", "file,http,https,tcp,tls",
      "-i", localM3U8
    ];

    if (subtitleFile && subtitle_mode === "hard") {
      ffArgs.push(
        "-vf", `subtitles=${subtitleFile}`,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-c:a", "copy"
      );
    } else if (subtitleFile && subtitle_mode === "soft") {
      ffArgs.push(
        "-i", subtitleFile,
        "-c", "copy",
        "-c:s", "mov_text"
      );
    } else {
      ffArgs.push("-c", "copy");
    }

    ffArgs.push(output);

    await new Promise((resolve, reject) => {
      const ff = spawn("ffmpeg", ffArgs);

      ff.stderr.on("data", d => console.log(`[${id}] ${d}`));

      ff.on("close", code => {
        code === 0 ? resolve() : reject(new Error("ffmpeg failed"));
      });
    });

    const size = fs.statSync(output).size;

    jobs[id].status = "done";
    jobs[id].file = output;
    jobs[id].size = formatSize(size);
    jobs[id].progress = "100%";

  } catch (e) {
    log(id, "ERROR: " + e.message);
    jobs[id].status = "error";
    jobs[id].error = e.message;
  }
}

// ===== ROUTES =====
app.post("/convert", (req, res) => {
  const id = Date.now().toString();

  const {
    episode_id,
    quality = "high",
    subtitle = false,
    subtitle_mode = "hard"
  } = req.body;

  jobs[id] = {
    status: "processing",
    progress: "0%",
    total: 0,
    downloaded: 0,
    size: null,
    file: null,
    error: null
  };

  processJob(id, episode_id, quality, subtitle, subtitle_mode);

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

  const stat = fs.statSync(job.file);

  res.writeHead(200, {
    "Content-Type": "video/mp4",
    "Content-Disposition": `attachment; filename="video_${req.params.id}.mp4"`,
    "Content-Length": stat.size
  });

  fs.createReadStream(job.file).pipe(res);
});

app.listen(PORT, () => console.log("🚀 Running on", PORT));

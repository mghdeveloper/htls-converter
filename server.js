{
  "name": "htls-converter",
  "version": "2.0.0",
  "description": "Fast HLS (m3u8) to MP4 converter with progress tracking and subtitles",
  "main": "server.js",
  "type": "module",
  "scripts": {
    "start": "node server.js"
  },
  "keywords": [
    "hls",
    "m3u8",
    "ffmpeg",
    "video",
    "converter"
  ],
  "dependencies": {
    "express": "^4.18.2",
    "fluent-ffmpeg": "^2.1.2",
    "m3u8stream": "^0.8.6",
    "uuid": "^9.0.1"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}

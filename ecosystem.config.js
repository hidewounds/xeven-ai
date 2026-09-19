const path = require("path");
module.exports = {
    apps: [
        {
            name: "xeven-api",
            script: path.join(__dirname, "server/index.js"),
            cwd: __dirname,
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: "1G",
            env: {
                NODE_ENV: "production",
                PORT: 3000,
            },
        },
        {
            name: "xeven-echo-sidecar",
            script: path.join(__dirname, "echo/server.py"),
            interpreter: "python",
            interpreter_args: "-u",
            args: "--model tiny --port 8765 --host 127.0.0.1",
            cwd: __dirname,
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: "4G",
            env: {
                ECHO_MODEL: "tiny",
                ECHO_PORT: "8765",
                ECHO_HOST: "127.0.0.1",
                PYTHONPATH: path.join(__dirname, "echo"),
                // PATH and FFMPEG_BINARY: set FFMPEG_BINARY env to an absolute ffmpeg path
                // if ffmpeg is not on PATH. Do not hardcode user-specific WinGet paths.
                ...(process.env.FFMPEG_BINARY ? { FFMPEG_BINARY: process.env.FFMPEG_BINARY } : {}),
            },
        },
    ],
};
const path = require("path");
module.exports = {
    apps: [
        {
            name: "nova-api",
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
            name: "nova-echo-sidecar",
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
                PATH: process.env.PATH + ";" + "C:\\Users\\dhana\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.1-full_build\\bin",
                FFMPEG_BINARY: "C:\\Users\\dhana\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.1-full_build\\bin\\ffmpeg.exe",
            },
        },
    ],
};
/**
 * XEVEN Voice Client — WebRTC microphone streaming to Echo sidecar
 * Handles: MediaRecorder, WebSocket streaming, VAD, barge-in, TTS interruption
 */

(function () {
    "use strict";

    // Localhost sidecar defaults apply ONLY on loopback hosts. Anywhere else
    // the caller must pass explicit URLs (or rely on server/browser STT/TTS).
    function isLoopbackHost() {
        try {
            const h = String(window.location.hostname || "").toLowerCase();
            return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
        } catch (e) { return false; }
    }
    const DEFAULT_SIDECAR_WS = isLoopbackHost() ? "ws://127.0.0.1:8765/ws/transcribe" : "";
    const DEFAULT_TTS_WS = isLoopbackHost() ? "ws://127.0.0.1:8765/ws/tts" : "";
    const AUDIO_CONSTRAINTS = {
        audio: {
            channelCount: 1,
            sampleRate: 16000,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
        },
    };
    const CHUNK_INTERVAL_MS = 100; // Send audio every 100ms

    class XevenVoiceClient {
        constructor(options = {}) {
            this.sidecarWsUrl = options.sidecarWsUrl || DEFAULT_SIDECAR_WS;
            this.ttsWsUrl = options.ttsWsUrl || DEFAULT_TTS_WS;
            this.language = options.language || "en";
            this.prompt = options.prompt || "";
            this.wordTimestamps = options.wordTimestamps || false;
            this.onTranscript = options.onTranscript || (() => {});
            this.onError = options.onError || (() => {});
            this.onStateChange = options.onStateChange || (() => {});

            this.mediaStream = null;
            this.mediaRecorder = null;
            this.sidecarWs = null;
            this.ttsWs = null;
            this.audioContext = null;
            this.processorNode = null;
            this.isRecording = false;
            this.isPlayingTTS = false;
            this.transcriptBuffer = "";
            this.finalTranscript = "";
            this.reconnectAttempts = 0;
            this.maxReconnectAttempts = 5;
        }

        setState(state) {
            this.state = state;
            this.onStateChange(state);
        }

        async start() {
            if (this.isRecording) return;

            try {
                this.setState("requesting_mic");
                this.mediaStream = await navigator.mediaDevices.getUserMedia(AUDIO_CONSTRAINTS);
                this.setState("connecting");

                await this.connectSidecar();
                await this.startRecording();

                this.isRecording = true;
                this.reconnectAttempts = 0;
                this.setState("recording");
            } catch (err) {
                this.setState("error");
                this.onError(err);
                throw err;
            }
        }

        async connectSidecar() {
            return new Promise((resolve, reject) => {
                try {
                    if (!this.sidecarWsUrl) {
                        reject(new Error("No voice sidecar configured for this host — pass sidecarWsUrl explicitly or use server/browser speech."));
                        return;
                    }
                    this.sidecarWs = new WebSocket(this.sidecarWsUrl);

                    this.sidecarWs.onopen = () => {
                        this.sidecarWs.send(JSON.stringify({
                            type: "config",
                            language: this.language,
                            prompt: this.prompt,
                            word_timestamps: this.wordTimestamps,
                        }));
                        resolve();
                    };

                    this.sidecarWs.onmessage = (event) => {
                        try {
                            const msg = JSON.parse(event.data);
                            this.handleSidecarMessage(msg);
                        } catch (e) {
                            // Ignore parse errors
                        }
                    };

                    this.sidecarWs.onerror = (err) => {
                        this.onError(new Error("Sidecar WebSocket error"));
                    };

                    this.sidecarWs.onclose = () => {
                        if (this.isRecording) {
                            this.handleSidecarDisconnect();
                        }
                    };
                } catch (e) {
                    reject(e);
                }

                setTimeout(() => reject(new Error("Connection timeout")), 10000);
            });
        }

        handleSidecarMessage(msg) {
            if (msg.type === "transcript") {
                this.transcriptBuffer = msg.text;
                this.onTranscript({
                    text: msg.text,
                    language: msg.language,
                    final: msg.final,
                    words: msg.words,
                });

                if (msg.final) {
                    this.finalTranscript = msg.text;
                    this.transcriptBuffer = "";
                }
            } else if (msg.type === "error") {
                this.onError(new Error(msg.message));
            }
        }

        async handleSidecarDisconnect() {
            this.setState("reconnecting");
            this.reconnectAttempts++;

            if (this.reconnectAttempts > this.maxReconnectAttempts) {
                this.setState("error");
                this.onError(new Error("Max reconnection attempts reached"));
                return;
            }

            await new Promise(r => setTimeout(r, 1000 * this.reconnectAttempts));

            try {
                await this.connectSidecar();
                this.setState("recording");
            } catch (e) {
                this.handleSidecarDisconnect();
            }
        }

        async startRecording() {
            return new Promise((resolve, reject) => {
                try {
                    // Use MediaRecorder for broad compatibility
                    this.mediaRecorder = new MediaRecorder(this.mediaStream, {
                        mimeType: "audio/webm;codecs=opus",
                    });

                    this.mediaRecorder.ondataavailable = (event) => {
                        if (event.data.size > 0 && this.sidecarWs?.readyState === WebSocket.OPEN) {
                            // Convert webm to raw PCM for sidecar
                            this.convertAndSend(event.data);
                        }
                    };

                    this.mediaRecorder.onstop = () => {
                        this.cleanupMedia();
                        resolve();
                    };

                    this.mediaRecorder.start(CHUNK_INTERVAL_MS);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        }

        async convertAndSend(webmBlob) {
            // For streaming, we decode webm to PCM using AudioContext
            if (!this.audioContext) {
                this.audioContext = new AudioContext({ sampleRate: 16000 });
            }

            try {
                const arrayBuffer = await webmBlob.arrayBuffer();
                const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
                const pcmData = this.audioBufferToInt16(audioBuffer);

                if (this.sidecarWs?.readyState === WebSocket.OPEN) {
                    this.sidecarWs.send(pcmData);
                }
            } catch (e) {
                // Fallback: send webm directly (sidecar handles via torchaudio)
                if (this.sidecarWs?.readyState === WebSocket.OPEN) {
                    const arrayBuffer = await webmBlob.arrayBuffer();
                    this.sidecarWs.send(arrayBuffer);
                }
            }
        }

        audioBufferToInt16(audioBuffer) {
            const numChannels = audioBuffer.numberOfChannels;
            const length = audioBuffer.length;
            const result = new Int16Array(length);
            const channelData = audioBuffer.getChannelData(0); // Mono

            for (let i = 0; i < length; i++) {
                const s = Math.max(-1, Math.min(1, channelData[i]));
                result[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            return result.buffer;
        }

        stop() {
            if (!this.isRecording) return Promise.resolve();

            this.isRecording = false;

            return new Promise((resolve) => {
                if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
                    this.mediaRecorder.onstop = () => {
                        this.cleanupMedia();
                        this.closeSidecar();
                        this.setState("stopped");
                        resolve();
                    };
                    this.mediaRecorder.stop();
                } else {
                    this.cleanupMedia();
                    this.closeSidecar();
                    this.setState("stopped");
                    resolve();
                }
            });
        }

        cleanupMedia() {
            if (this.mediaStream) {
                this.mediaStream.getTracks().forEach(t => t.stop());
                this.mediaStream = null;
            }
            if (this.audioContext) {
                this.audioContext.close();
                this.audioContext = null;
            }
            this.mediaRecorder = null;
        }

        closeSidecar() {
            if (this.sidecarWs) {
                this.sidecarWs.close();
                this.sidecarWs = null;
            }
        }

        // Send final flush to get any remaining transcript
        flush() {
            if (this.sidecarWs?.readyState === WebSocket.OPEN) {
                this.sidecarWs.send(JSON.stringify({ type: "flush" }));
            }
        }

        // Change language mid-session
        setLanguage(lang) {
            this.language = lang;
            if (this.sidecarWs?.readyState === WebSocket.OPEN) {
                this.sidecarWs.send(JSON.stringify({ type: "config", language: lang }));
            }
        }

        // ==================== TTS / Barge-in ====================

        async speak(text, options = {}) {
            if (this.isPlayingTTS) {
                this.interruptTTS();
            }

            return new Promise((resolve, reject) => {
                try {
                    this.ttsWs = new WebSocket(this.ttsWsUrl);
                    this.isPlayingTTS = true;
                    this.setState("speaking");

                    this.ttsWs.onopen = () => {
                        this.ttsWs.send(JSON.stringify({
                            type: "synthesize",
                            text,
                            voice: options.voice || "en_US-lessac-medium",
                            language: options.language || this.language,
                        }));
                    };

                    const audioChunks = [];
                    this.ttsWs.onmessage = (event) => {
                        if (event.data instanceof Blob || event.data instanceof ArrayBuffer) {
                            audioChunks.push(event.data);
                        } else {
                            try {
                                const msg = JSON.parse(event.data);
                                if (msg.type === "done") {
                                    this.playAudioChunks(audioChunks).then(resolve);
                                } else if (msg.type === "error") {
                                    reject(new Error(msg.message));
                                }
                            } catch (e) {
                                // Binary data
                            }
                        }
                    };

                    this.ttsWs.onerror = (err) => {
                        this.isPlayingTTS = false;
                        this.setState("recording");
                        reject(err);
                    };

                    this.ttsWs.onclose = () => {
                        this.isPlayingTTS = false;
                        this.setState("recording");
                    };
                } catch (e) {
                    this.isPlayingTTS = false;
                    reject(e);
                }
            });
        }

        async playAudioChunks(chunks) {
            if (!this.audioContext) {
                this.audioContext = new AudioContext({ sampleRate: 16000 });
            }

            // Concatenate all chunks
            let totalLength = 0;
            chunks.forEach(c => totalLength += c.byteLength);
            const combined = new Uint8Array(totalLength);
            let offset = 0;
            chunks.forEach(c => {
                combined.set(new Uint8Array(c), offset);
                offset += c.byteLength;
            });

            // Decode and play
            const audioBuffer = await this.audioContext.decodeAudioData(combined.buffer);
            const source = this.audioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(this.audioContext.destination);
            source.start(0);

            return new Promise(resolve => {
                source.onended = resolve;
            });
        }

        interruptTTS() {
            // Barge-in: stop current TTS playback
            if (this.ttsWs) {
                this.ttsWs.close();
                this.ttsWs = null;
            }
            if (this.audioContext) {
                // Stop all sources
                this.audioContext.close();
                this.audioContext = null;
            }
            this.isPlayingTTS = false;
        }

        // Get final transcript (after stop)
        getFinalTranscript() {
            return this.finalTranscript || this.transcriptBuffer;
        }

        // Full cleanup
        destroy() {
            this.stop();
            this.interruptTTS();
            this.onTranscript = null;
            this.onError = null;
            this.onStateChange = null;
        }
    }

    // Export for module systems
    if (typeof module !== "undefined" && module.exports) {
        module.exports = { XevenVoiceClient };
    } else {
        window.XevenVoiceClient = XevenVoiceClient;
    }
})();
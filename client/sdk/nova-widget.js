// ============================================================
// NOVA WIDGET — embeddable chat widget (chrono + echo aware)
//
// Usage:
//   <script src="https://your-nova-host/widget/nova-widget.js"
//           data-public-key="nova_pk_xxx"
//           data-api="https://your-nova-host"
//           defer></script>
// ============================================================

(function () {
    "use strict";

    var currentScript =
        document.currentScript ||
        (function () {
            var scripts = document.getElementsByTagName("script");
            return scripts[scripts.length - 1];
        })();

    if (!currentScript) {
        console.error("NOVA Widget: unable to locate script element.");
        return;
    }

    var publicKey = currentScript.getAttribute("data-public-key") || "";
    var apiBase = (currentScript.getAttribute("data-api") || "").replace(/\/+$/, "");

    if (!apiBase) {
        try {
            apiBase = new URL(currentScript.src, window.location.href).origin;
        } catch (e) {
            apiBase = "";
        }
    }

    if (!publicKey) {
        console.error('NOVA Widget: data-public-key is required. Example: <script data-public-key="nova_pk_...">');
        return;
    }

    // -------------------------------------------------------
    // load guide overlay (pointer) — nova-guide.js
    // -------------------------------------------------------
    (function loadGuide(){
        try {
            var g = document.createElement("script");
            g.src = apiBase + "/widget/nova-guide.js";
            g.async = true;
            g.onerror = function(){};
            document.head.appendChild(g);
        } catch {}
    })();

    // -------------------------------------------------------
    // visitor identity
    // -------------------------------------------------------

    function getVisitorId() {
        try {
            var id = localStorage.getItem("nova_visitor_id");
            if (id) return id;
            id = "visitor_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
            localStorage.setItem("nova_visitor_id", id);
            return id;
        } catch (e) {
            return "anonymous";
        }
    }

    // -------------------------------------------------------
    // styles
    // -------------------------------------------------------

    var style = document.createElement("style");
    style.textContent = [
        "@import url('https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=Space+Grotesk:wght@600;700&family=JetBrains+Mono:wght@600;700&display=swap');",
        "#nova-widget-button{position:fixed;right:22px;bottom:22px;width:58px;height:58px;border-radius:16px;border:1px solid rgba(255,255,255,.14);cursor:pointer;background:linear-gradient(135deg,#8b5cf6 0%,#6366f1 45%,#06b6d4 100%);color:#fff;font-size:22px;font-weight:800;box-shadow:0 8px 24px rgba(139,92,246,.35), inset 0 1px 0 rgba(255,255,255,.18);z-index:2147483000;display:flex;align-items:center;justify-content:center;transition:transform .22s cubic-bezier(.16,1,.3,1), box-shadow .22s;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);font-family:'Space Grotesk',sans-serif}",
        "#nova-widget-button:hover{transform:translateY(-2px) scale(1.02);box-shadow:0 14px 36px rgba(139,92,246,.45)}",
        "#nova-widget{position:fixed;right:22px;bottom:90px;width:380px;max-width:calc(100vw - 24px);height:560px;max-height:calc(100vh - 110px);display:none;flex-direction:column;background:linear-gradient(180deg, rgba(255,255,255,.08), rgba(255,255,255,.02));backdrop-filter:blur(20px) saturate(1.5);-webkit-backdrop-filter:blur(20px) saturate(1.5);border:1px solid rgba(255,255,255,.11);border-radius:24px;box-shadow:0 24px 64px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.08);overflow:hidden;z-index:2147483000;font-family:'Instrument Sans',system-ui,-apple-system,sans-serif;color:#f1f5f9}",
        "#nova-widget.open{display:flex;animation:novaIn .32s cubic-bezier(.16,1,.3,1)}",
        "@keyframes novaIn{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}",
        "#nova-widget::before{content:'';position:absolute;inset:0;border-radius:24px;padding:1px;background:linear-gradient(135deg, rgba(255,255,255,.14), rgba(255,255,255,0), rgba(139,92,246,.22));-webkit-mask:linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);mask:linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none;opacity:.9}",
        "#nova-widget-header{padding:16px 16px 14px;display:flex;align-items:center;gap:12px;border-bottom:1px solid rgba(255,255,255,.07);background:linear-gradient(180deg, rgba(255,255,255,.04), transparent);position:relative;z-index:1}",
        "#nova-widget-av{width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,#8b5cf6 0%,#6366f1 45%,#06b6d4 100%);display:flex;align-items:center;justify-content:center;color:#fff;font-family:'Space Grotesk',sans-serif;font-weight:800;font-size:18px;box-shadow:0 4px 14px rgba(139,92,246,.35);flex-shrink:0}",
        "#nova-widget-title{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:15px;color:#fff;line-height:1}",
        "#nova-widget-sub{font-size:11.5px;color:#10b981;font-weight:700;display:flex;align-items:center;gap:6px;margin-top:2px}",
        "#nova-widget-sub::before{content:'';width:7px;height:7px;border-radius:50%;background:#10b981;box-shadow:0 0 0 5px rgba(16,185,129,.14);animation:novaPulse 2s infinite}",
        "@keyframes novaPulse{0%,100%{box-shadow:0 0 0 5px rgba(16,185,129,.14)}50%{box-shadow:0 0 0 9px rgba(16,185,129,0)}}",
        "#nova-widget-live{margin-left:auto;font-family:'JetBrains Mono',monospace;font-size:10.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#c4b5fd;background:rgba(139,92,246,.14);border:1px solid rgba(139,92,246,.2);padding:6px 10px;border-radius:999px;white-space:nowrap}",
        "#nova-widget-close{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.11);color:#fff;border-radius:10px;padding:6px 9px;font-size:12px;cursor:pointer;backdrop-filter:blur(8px);transition:.2s;margin-left:4px}",
        "#nova-widget-close:hover{background:rgba(255,255,255,.1)}",
        "#nova-widget-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;background:transparent;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.14) transparent;position:relative;z-index:1}",
        "#nova-widget-messages::-webkit-scrollbar{width:4px}#nova-widget-messages::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:999px}",
        ".nova-msg{max-width:86%;padding:12px 16px;border-radius:18px;font-size:14px;line-height:1.55;white-space:pre-wrap;word-wrap:break-word;position:relative;backdrop-filter:blur(8px);border:1px solid transparent}",
        ".nova-msg.user{align-self:flex-end;background:linear-gradient(135deg,#8b5cf6 0%,#6366f1 45%,#06b6d4 100%);color:#fff;border-color:rgba(255,255,255,.14);border-bottom-right-radius:6px;box-shadow:0 8px 18px rgba(139,92,246,.28)}",
        ".nova-msg.assistant{align-self:flex-start;background:rgba(255,255,255,.06);color:#f1f5f9;border-color:rgba(255,255,255,.07);border-bottom-left-radius:6px}",
        ".nova-msg .nova-tag{font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;display:block;margin-bottom:4px;opacity:.94}",
        ".nova-msg.assistant .nova-tag{color:#a78bfa}.nova-msg.user .nova-tag{color:rgba(255,255,255,.92)}",
        ".nova-msg.nova-loading{opacity:.6;font-size:13px;background:transparent;border:none;padding:4px 8px;color:#94a3b8;backdrop-filter:none}",
        ".nova-msg strong{font-weight:700;color:#fff}",
        ".nova-msg em{font-style:italic;opacity:.9}",
        "#nova-widget-input-area{display:flex;gap:8px;padding:12px;border-top:1px solid rgba(255,255,255,.07);background:rgba(255,255,255,.02);align-items:flex-end;backdrop-filter:blur(12px);position:relative;z-index:1}",
        "#nova-widget-input{flex:1;resize:none;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.06);border-radius:999px;padding:10px 14px;font-size:14px;font-family:'Instrument Sans',sans-serif;outline:none;max-height:110px;color:#f1f5f9;transition:.18s}",
        "#nova-widget-input::placeholder{color:#64748b}",
        "#nova-widget-input:focus{border-color:rgba(139,92,246,.35);box-shadow:0 0 0 4px rgba(139,92,246,.12);background:rgba(255,255,255,.08)}",
        "#nova-widget-send{width:38px;height:38px;min-width:38px;border:none;border-radius:50%;background:linear-gradient(135deg,#8b5cf6 0%,#6366f1 45%,#06b6d4 100%);color:#fff;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 16px rgba(139,92,246,.28);transition:.18s;flex-shrink:0}",
        "#nova-widget-send:hover{transform:translateY(-1px);box-shadow:0 10px 22px rgba(139,92,246,.35)}",
        "#nova-widget-send:disabled{opacity:.5;cursor:default;transform:none}",
        "#nova-mic{width:38px;height:38px;min-width:38px;border:1px solid rgba(255,255,255,.11);border-radius:50%;background:rgba(255,255,255,.06);color:#f1f5f9;font-size:15px;cursor:pointer;display:none;backdrop-filter:blur(8px);transition:.2s;flex-shrink:0}",
        "#nova-mic:hover{background:rgba(255,255,255,.1)}",
        "#nova-mic.on{background:#ef4444;color:#fff;border-color:#ef4444;animation:novaPulseMic 1.2s infinite}",
        "@keyframes novaPulseMic{0%{opacity:1}50%{opacity:.75}100%{opacity:1}}",
        "#nova-avail-toggle{width:38px;height:38px;min-width:38px;border:1px solid rgba(255,255,255,.11);border-radius:50%;background:rgba(255,255,255,.06);color:#f1f5f9;font-size:14px;cursor:pointer;backdrop-filter:blur(8px);flex-shrink:0}",
        "#nova-avail-toggle:hover{background:rgba(255,255,255,.1)}",
        "#nova-avail-panel{display:none;max-height:170px;overflow-y:auto;border-top:1px solid rgba(255,255,255,.07);background:rgba(15,18,33,.94);backdrop-filter:blur(16px);padding:10px;font-size:12.5px;color:#cbd5e1;position:relative;z-index:1}",
        "#nova-avail-panel.open{display:block}",
        ".nova-slot{display:inline-flex;align-items:center;margin:4px 4px;padding:6px 12px;border:1px solid rgba(255,255,255,.1);border-radius:999px;cursor:pointer;font-size:12.5px;font-weight:600;background:rgba(255,255,255,.06);color:#f1f5f9;backdrop-filter:blur(8px);transition:.2s}",
        ".nova-slot:hover{background:linear-gradient(135deg,#8b5cf6 0%,#6366f1 100%);color:#fff;border-color:transparent;transform:translateY(-1px)}",
        ".nova-chip{font-size:12.5px;font-weight:600;padding:8px 12px;border-radius:999px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.07);color:#f1f5f9;cursor:pointer;transition:.2s;backdrop-filter:blur(8px)}",
        ".nova-chip:hover{background:rgba(139,92,246,.18);border-color:rgba(139,92,246,.35);color:#fff;transform:translateY(-1px)}",
        "@media(max-width:500px){#nova-widget{right:10px;left:10px;width:auto;bottom:84px;height:68vh}#nova-widget-button{right:16px;bottom:16px;width:54px;height:54px}}"
    ].join("\n");
    document.head.appendChild(style);

    // deeper UI improvisation — widget learns design system so it sits to its core like nova web image
    // learns primary, darkMode, radius, fonts, spacing + keeps glass when site is dark (#050508)
    function applyWidgetTheme(theme, customerBase){
        if(!theme || typeof theme !== "object") return;
        try{
            if(theme.restricted) return;
            var primary = theme.primary || null;
            var secondary = theme.secondary || null;
            var bg = theme.background || null;
            var surface = theme.surface || null;
            var text = theme.text || null;
            var muted = theme.muted || null;
            var border = theme.border || null;
            var font = theme.fontFamily || null;
            var headingFont = theme.headingFont || null;
            var radius = theme.radius || null;
            var radiusLg = theme.radiusLg || null;
            var shadow = theme.shadow || null;
            var spacing = theme.spacing || null;
            var darkMode = theme.darkMode;
            var css = "";
            // site is dark by default (nova web #050508) — keep glass; don't override glass with flat
            // primary — button, send, av, user bubble — keep gradient core but tint if brand is distinct
            if(primary && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(primary) && primary.toLowerCase() !== "#8b5cf6" && primary.toLowerCase() !== "#6366f1"){
                // if site brand is not violet, blend it into widget's gradient per site
                css += "\n#nova-widget-button{background:"+primary+"!important;border-color:"+primary+"!important}";
                css += "\n#nova-widget-av{background:"+primary+"!important}";
                css += "\n#nova-widget-send{background:"+primary+"!important}";
                css += "\n.nova-msg.user{background:"+primary+"!important;border-color:"+primary+"!important}";
                try{ document.documentElement.style.setProperty("--nova-primary", primary); }catch{}
                if(button) button.style.background = primary;
            }
            if(secondary && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(secondary)){
                css += "\n#nova-mic.on{background:"+secondary+"!important}";
            }
            // dark/light — site dark (#050508) → keep glass (already dark), site light → switch to light glass
            if(darkMode === false){
                // light site — widget becomes light glass: white translucent instead of dark
                css += "\n#nova-widget{background:linear-gradient(180deg, rgba(255,255,255,.92), rgba(255,255,255,.78))!important;color:#0f1221!important;border-color:rgba(15,18,33,.08)!important;box-shadow:0 20px 50px rgba(15,18,33,.12)!important}";
                css += "\n#nova-widget-header{background:rgba(255,255,255,.4)!important;border-color:rgba(15,18,33,.06)!important}";
                css += "\n#nova-widget-title{color:#0f1221!important}";
                css += "\n.nova-msg.assistant{background:rgba(15,18,33,.04)!important;color:#1a2038!important;border-color:rgba(15,18,33,.08)!important}";
                css += "\n#nova-widget-input-area{background:rgba(255,255,255,.6)!important;border-color:rgba(15,18,33,.06)!important}";
                css += "\n#nova-widget-input{background:rgba(255,255,255,.9)!important;color:#1a2038!important;border-color:rgba(15,18,33,.1)!important}";
                css += "\n#nova-widget-input::placeholder{color:#94a3b8!important}";
                css += "\n#nova-avail-panel{background:rgba(255,255,255,.96)!important;border-color:rgba(15,18,33,.06)!important;color:#1a2038!important}";
                css += "\n.nova-slot{background:#fff!important;color:#1a2038!important;border-color:rgba(15,18,33,.1)!important}";
            }
            if(bg && bg.length>2 && bg !== "rgba(255,255,255,.015)" && darkMode===false){
                try{ if(widget) widget.style.background = bg; }catch{}
            }
            if(surface && surface.length>2 && darkMode===false){
                css += "\n.nova-msg.assistant{background:"+surface+"!important}";
            }
            if(text && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(text)){
                if(darkMode===false) css += "\n#nova-widget{color:"+text+"!important}";
            }
            if(muted && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(muted)){
                css += "\n#nova-widget-messages .nova-msg.nova-loading{color:"+muted+"!important}";
            }
            if(border && border.length>2){
                css += "\n#nova-widget{border-color:"+border+"!important}";
                css += "\n#nova-widget-header{border-color:"+border+"!important}";
            }
            // fonts — nova web uses Instrument Sans / Space Grotesk / JetBrains Mono — keep them
            if(font && font.length>2){
                var f = font + ", 'Instrument Sans', system-ui, -apple-system, sans-serif";
                if(widget) widget.style.fontFamily = f;
                if(button) button.style.fontFamily = font + ", sans-serif";
                css += "\n#nova-widget{font-family:"+f+"!important}";
            }
            if(headingFont && headingFont.length>2){
                css += "\n#nova-widget-header{font-family:"+headingFont+", 'Space Grotesk', sans-serif!important}";
                css += "\n#nova-widget-title{font-family:"+headingFont+", 'Space Grotesk', sans-serif!important}";
            }
            // radius — site --r-lg 22-24px → widget radius
            var r = radiusLg || radius;
            if(r && /^\d+(px|rem|%|)$/.test(r)){
                var rv = r.match(/^\d+$/) ? r+"px" : r;
                css += "\n#nova-widget{border-radius:"+rv+"!important}";
                css += "\n#nova-widget::before{border-radius:"+rv+"!important}";
                if(widget) widget.style.borderRadius = rv;
            }
            if(shadow && shadow.length>5){
                // keep glass shadow, but blend site shadow
                css += "\n#nova-widget{box-shadow:"+shadow+", 0 24px 64px rgba(0,0,0,.18)!important}";
            }
            if(spacing && /^\d+(px|rem)$/.test(spacing)){
                css += "\n#nova-widget-messages{gap:"+spacing+"!important}";
            }
            if(css) {
                var s = document.createElement("style");
                s.id = "nova-widget-theme";
                s.textContent = css;
                var old = document.getElementById("nova-widget-theme");
                if(old) old.remove();
                document.head.appendChild(s);
            }
            // customer base — adapt title / avatar style subtly
            if(customerBase){
                var title = widget ? widget.querySelector("#nova-widget-title") : null;
                if(title){
                    if(customerBase.indexOf("fashion")!==-1 && title.textContent==="Nova") title.textContent="Style Assistant";
                    // business keeps Nova, general keeps Nova — subtle, human
                }
            }
            try{ localStorage.setItem("nova_widget_theme", JSON.stringify({primary:primary, secondary:secondary, bg:bg, surface:surface, font:font, headingFont:headingFont, radius:r, shadow:shadow, customerBase:customerBase, darkMode:darkMode, at:Date.now()})); }catch{}
        }catch(e){}
    }
    // expose for manual refresh
    window.NOVA_APPLY_THEME = applyWidgetTheme;

    // browser TTS fallback — guarantees voice reply even when server TTS (piper/openai) unavailable
    function tryBrowserTTS(text, lang){
        try{
            if(!text || !window.speechSynthesis || !window.SpeechSynthesisUtterance) return false;
            try{ window.speechSynthesis.cancel(); }catch{}
            var u = new SpeechSynthesisUtterance(String(text).slice(0, 4000));
            var map = {en:'en-US', es:'es-ES', fr:'fr-FR', de:'de-DE', pt:'pt-PT', it:'it-IT', ja:'ja-JP', ko:'ko-KR', zh:'zh-CN', ar:'ar-SA', hi:'hi-IN', ru:'ru-RU', nl:'nl-NL', tr:'tr-TR', pl:'pl-PL'};
            var code = (lang||'en').toLowerCase().slice(0,2);
            if(map[code]) u.lang = map[code];
            else if(lang && lang.indexOf('-')!==-1) u.lang = lang;
            else u.lang = 'en-US';
            u.rate = 1.0; u.volume = 1.0;
            window.speechSynthesis.speak(u);
            return true;
        }catch(e){ return false; }
    }
    window.NOVA_TTS_FALLBACK = tryBrowserTTS;

    // whisper.wasm via transformers.js — pure browser STT, no sidecar/key needed (for Vercel prod)
    var wasmTranscriber = null;
    var wasmLoading = null;
    async function loadWasmTranscriber(){
        if(wasmTranscriber) return wasmTranscriber;
        if(wasmLoading) return wasmLoading;
        wasmLoading = (async function(){
            try{
                // transformers.min.js is UMD, not ESM — load via script tag, not import()
                if(!window.transformers?.pipeline){
                    await new Promise(function(res, rej){
                        var s=document.createElement('script');
                        s.src='https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js';
                        s.onload=res; s.onerror=function(){ rej(new Error('failed to load transformers')); }; document.head.appendChild(s);
                    });
                }
                var pipeline = window.transformers?.pipeline || window.pipeline;
                if(!pipeline) throw new Error('pipeline not found after script load');
                // Use tiny.en for English; fallback to tiny for multilingual if needed
                var modelId = multilanguageEnabled ? 'Xenova/whisper-tiny' : 'Xenova/whisper-tiny.en';
                wasmTranscriber = await pipeline('automatic-speech-recognition', modelId);
                return wasmTranscriber;
            } catch(e){
                console.warn('wasm load failed', e);
                wasmLoading = null;
                throw e;
            }
        })();
        return wasmLoading;
    }
    async function transcribeWithWasm(blob){
        try{
            var transcriber = await loadWasmTranscriber();
            var arrayBuffer = await blob.arrayBuffer();
            // decode via AudioContext to get Float32 at 16kHz (browser can decode webm opus)
            var AudioCtx = window.AudioContext || window.webkitAudioContext;
            var ac = new AudioCtx({sampleRate: 16000});
            var audioBuffer = await ac.decodeAudioData(arrayBuffer.slice(0));
            var float32 = audioBuffer.getChannelData(0);
            // transformers expects Float32Array at 16kHz
            var result = await transcriber(float32);
            try{ ac.close(); }catch{}
            return result && result.text ? String(result.text).trim() : "";
        } catch(e){
            console.warn('wasm transcribe failed', e);
            return "";
        }
    }
    window.NOVA_WASM_TRANSCRIBE = transcribeWithWasm;

    // SpeechRecognition fallback for Vercel prod when sidecar+wasm both unavailable — no download, instant
    function transcribeWithSpeechRecognitionOnce(){
        return new Promise(function(resolve){
            try{
                var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
                if(!SR){ resolve(""); return; }
                var rec = new SR();
                rec.lang = multilanguageEnabled ? "" : "en-US";
                rec.interimResults = false;
                rec.maxAlternatives = 1;
                var timeout = setTimeout(function(){ try{ rec.stop(); }catch{} resolve(""); }, 8000);
                rec.onresult = function(ev){
                    clearTimeout(timeout);
                    var transcript = ev.results && ev.results[0] && ev.results[0][0] ? ev.results[0][0].transcript : "";
                    resolve(transcript ? String(transcript).trim() : "");
                };
                rec.onerror = function(){ clearTimeout(timeout); resolve(""); };
                rec.onend = function(){ clearTimeout(timeout); };
                rec.start();
            }catch(e){ resolve(""); }
        });
    }

    // wav conversion — guarantees sidecar can decode without ffmpeg (webm opus → wav)
    function arrayBufferToBase64(buffer){
        try{
            var bytes = new Uint8Array(buffer);
            var binary = "";
            var chunk = 8192;
            for(var i=0;i<bytes.length;i+=chunk){
                binary += String.fromCharCode.apply(null, bytes.subarray(i, i+chunk));
            }
            return btoa(binary);
        }catch(e){ return ""; }
    }
    function encodeWav(samples, sampleRate){
        var bufLen = 44 + samples.length * 2;
        var buffer = new ArrayBuffer(bufLen);
        var view = new DataView(buffer);
        function writeString(offset, str){ for(var i=0;i<str.length;i++) view.setUint8(offset+i, str.charCodeAt(i)); }
        writeString(0, "RIFF");
        view.setUint32(4, 36 + samples.length * 2, true);
        writeString(8, "WAVE");
        writeString(12, "fmt ");
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        writeString(36, "data");
        view.setUint32(40, samples.length * 2, true);
        var offset = 44;
        for(var i=0;i<samples.length;i++){
            var s = Math.max(-1, Math.min(1, samples[i]));
            view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
            offset += 2;
        }
        return buffer;
    }
    function blobToWavBase64(blob, cb){
        try{
            if(!blob || blob.size < 100) { cb(null); return; }
            // already wav — fast path
            if(blob.type && blob.type.indexOf("wav") !== -1){
                var r = new FileReader();
                r.onload = function(){ try{ var b64 = String(r.result).split(",")[1]||""; cb(b64, "audio/wav"); }catch(e){ cb(null); } };
                r.onerror = function(){ cb(null); };
                r.readAsDataURL(blob);
                return;
            }
            var AudioCtx = window.AudioContext || window.webkitAudioContext;
            if(!AudioCtx){
                var r2 = new FileReader();
                r2.onload = function(){ try{ var b64 = String(r2.result).split(",")[1]||""; cb(b64, blob.type || "audio/webm"); }catch(e){ cb(null); } };
                r2.onerror = function(){ cb(null); };
                r2.readAsDataURL(blob);
                return;
            }
            var ac = new AudioCtx({sampleRate: 16000});
            var reader = new FileReader();
            reader.onload = function(){
                try{
                    var arrayBuf = reader.result;
                    ac.decodeAudioData(arrayBuf, function(audioBuffer){
                        try{
                            var ch0 = audioBuffer.getChannelData(0);
                            // if stereo, mix down (already mono via getChannelData 0, but ensure)
                            var wavBuf = encodeWav(ch0, audioBuffer.sampleRate);
                            var b64wav = arrayBufferToBase64(wavBuf);
                            cb(b64wav, "audio/wav");
                        }catch(e){ cb(null); }
                        try{ ac.close(); }catch{}
                    }, function(){ cb(null); try{ ac.close(); }catch{} });
                }catch(e){ cb(null); }
            };
            reader.onerror = function(){ cb(null); };
            reader.readAsArrayBuffer(blob);
        }catch(e){ cb(null); }
    }

    // -------------------------------------------------------
    // elements
    // -------------------------------------------------------

    var button = document.createElement("button");
    button.id = "nova-widget-button";
    button.setAttribute("aria-label", "Open NOVA assistant");
    button.textContent = "N";

    var widget = document.createElement("div");
    widget.id = "nova-widget";
    widget.innerHTML =
        '<div id="nova-widget-header"><div id="nova-widget-av">N</div><div><div id="nova-widget-title">Nova</div><div id="nova-widget-sub">online</div></div><span id="nova-widget-live">● LIVE</span><button id="nova-widget-close" aria-label="Close">✕</button></div>' +
        '<div id="nova-widget-messages"></div>' +
        '<div id="nova-avail-panel"></div>' +
        '<div id="nova-widget-input-area">' +
        '<textarea id="nova-widget-input" placeholder="Ask anything..." rows="1"></textarea>' +
        '<button id="nova-mic" title="Hold to speak" aria-label="Voice input">🎙</button>' +
        '<button id="nova-avail-toggle" title="Availability" aria-label="Availability">📅</button>' +
        '<button id="nova-widget-send" aria-label="Send">↗</button>' +
        "</div>";

    function mountWhenReady() {
        if (document.body) {
            document.body.appendChild(button);
            document.body.appendChild(widget);
        } else {
            document.addEventListener("DOMContentLoaded", function () {
                document.body.appendChild(button);
                document.body.appendChild(widget);
            });
        }
    }
    mountWhenReady();

    var messagesEl = null;
    var inputEl = null;
    var sendEl = null;
    var micEl = null;
    var availToggle = null;
    var availPanel = null;

    // will be assigned after DOM ready
    var voiceEnabled = false;
    var multilanguageEnabled = false;
    var sidecarAvailable = null; // null=unknown, true/false — checked via /api/health/echo

    setTimeout(function () {
        messagesEl = widget.querySelector("#nova-widget-messages");
        inputEl = widget.querySelector("#nova-widget-input");
        sendEl = widget.querySelector("#nova-widget-send");
        micEl = widget.querySelector("#nova-mic");
        availToggle = widget.querySelector("#nova-avail-toggle");
        availPanel = widget.querySelector("#nova-avail-panel");

        sendEl.addEventListener("click", sendMessage);
        button.addEventListener("click", toggle);
        var closeBtn = widget.querySelector("#nova-widget-close");
        if(closeBtn) closeBtn.addEventListener("click", function(e){ e.stopPropagation(); widget.classList.remove("open"); });
        if (availToggle) availToggle.addEventListener("click", toggleAvailability);
        inputEl.addEventListener("keydown", function (event) {
            if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
            }
        });
        // echo mic handlers
        if (micEl) {
            micEl.addEventListener("click", toggleMic);
        }

        loadConfig();
    }, 0);

    // -------------------------------------------------------
    // state
    // -------------------------------------------------------

    var messages = [];
    var conversationId = null;
    var busy = false;
    var availOpen = false;
    var recording = false;
    var mediaRecorder = null;
    var audioChunks = [];
    var hasWelcomed = false;
    var configLoaded = false;

    // -------------------------------------------------------
    // API
    // -------------------------------------------------------

    var availCache = null;
    var availCacheAt = 0;
    async function api(path, options) {
        options = options || {};
        options.headers = Object.assign({ "Content-Type": "application/json", "x-nova-key": publicKey }, options.headers || {});
        // Widget timeout: chat 20s, transcribe/others 20s — sidecar needs up to 5s for 10s audio on CPU, give headroom
        var isChat = path.indexOf("/chat") !== -1;
        var isTranscribe = path.indexOf("transcribe") !== -1 || path.indexOf("/tts/") !== -1;
        var timeoutMs = isChat ? 20000 : (isTranscribe ? 20000 : 10000);
        var controller = null;
        var timeoutId = null;
        try {
            if (typeof AbortController !== "undefined") {
                controller = new AbortController();
                options.signal = controller.signal;
                timeoutId = setTimeout(function () { try { controller.abort(); } catch {} }, timeoutMs);
            }
            var response = await fetch(apiBase + path, options);
            if (timeoutId) clearTimeout(timeoutId);
            var data = {};
            try {
                data = await response.json();
            } catch (e) {
                data = {};
            }
            if (!response.ok) {
                throw new Error((data && data.error && data.error.message) || "NOVA request failed.");
            }
            return data;
        } catch (e) {
            if (timeoutId) clearTimeout(timeoutId);
            if (e.name === "AbortError" || (e.message && e.message.indexOf("abort") !== -1)) {
                throw new Error(isChat ? "NOVA is thinking a bit long — please try again in a moment." : "Request timed out — please try again.");
            }
            throw e;
        }
    }

    async function loadConfig() {
        if (configLoaded && hasWelcomed) return;
        try {
            var data = await api("/api/v1/widget/config");
            if (data.config && data.config.assistantName) {
                var title = widget.querySelector("#nova-widget-title");
                if (title) title.textContent = data.config.assistantName;
            }
            if (data.config) {
                voiceEnabled = Boolean(data.config.voiceEnabled || data.config.addons?.voice_channel);
                multilanguageEnabled = Boolean(data.config.multilanguageEnabled || data.config.addons?.multilanguage);
                if ((voiceEnabled || multilanguageEnabled) && navigator.mediaDevices && window.MediaRecorder) {
                    if (micEl) micEl.style.display = "inline-block";
                }
                // check sidecar health — if prod Vercel has no sidecar, use browser STT directly for 100% guarantee
                try{
                    var health = await api("/api/health/echo", {method:"GET"}).catch(function(){ return {sidecar:{available:false}}; });
                    sidecarAvailable = !!(health && health.sidecar && health.sidecar.available);
                    // also try direct health if api wrapper fails due to timeout
                    if(sidecarAvailable===null || sidecarAvailable===undefined){
                        try{
                            var h2 = await fetch(apiBase + "/api/health/echo").then(function(r){ return r.json(); }).catch(function(){ return null; });
                            if(h2 && h2.sidecar) sidecarAvailable = !!h2.sidecar.available;
                        }catch{}
                    }
                }catch(e){ sidecarAvailable = false; }
                if(sidecarAvailable===false){
                    console.log("NOVA Echo sidecar not available — will use browser SpeechRecognition for prod");
                }
                // auto guide ONLY on first login visit — not on every first visit, not on "guide me" chat
                try {
                    var login = null; try { login = localStorage.getItem("nova_web_login") || localStorage.getItem("nova_login") || sessionStorage.getItem("nova_web_login"); } catch {}
                    var seenKey = login ? "nova_guide_seen_" + login : "nova_guide_seen";
                    var seen = null; try { seen = localStorage.getItem(seenKey); } catch {}
                    // only auto-start if logged in and not seen for this login
                    if(login && !seen && window.NOVA_GUIDE){
                        setTimeout(function(){
                            api("/api/v1/widget/guide",{method:"GET"}).then(function(gd){
                                var steps = (gd && gd.guide && gd.guide.steps && gd.guide.steps.length) ? gd.guide.steps : [
                                    { id:"welcome", title:"Welcome — I'll guide you", selector:"body", description:"Hi, I'm NOVA. I'll show you around in 60 seconds.", position:"center" },
                                    { id:"explore", title:"Explore", selector:"nav, header", description:"Browse what's here — I'll explain as we go.", position:"bottom" },
                                    { id:"ask", title:"Ask me anything on NOVA", selector:"#nova-widget-button", description:"Tour done. Ask any question — I handle basics, bookings and voice.", position:"left" }
                                ];
                                if(window.NOVA_GUIDE && window.NOVA_GUIDE.start){
                                    window.NOVA_GUIDE.start(steps, { onStep: function(){}});
                                    try { localStorage.setItem(seenKey,"1"); localStorage.setItem("nova_guide_seen","1"); } catch {}
                                    addMessage("assistant", "👋 Welcome back — showing you around. Follow the highlight, then ask me anything.");
                                    messages.push({role:"assistant", content:"Showing tour — follow highlight"});
                                    hasWelcomed=true;
                                }
                            }).catch(function(){
                                if(window.NOVA_GUIDE){
                                    window.NOVA_GUIDE.start([
                                        { id:"welcome", title:"Welcome — I'll guide you", selector:"body", description:"Hi, I'm NOVA. I'll show you around in 60 seconds.", position:"center" },
                                        { id:"ask", title:"Ask me anything on NOVA", selector:"#nova-widget-button", description:"Tour done. Ask any question.", position:"left" }
                                    ]);
                                    try { localStorage.setItem(seenKey,"1"); } catch {}
                                }
                            });
                        }, 1200);
                    }
                } catch {}
                // theme-aware: widget learns design & customer base from site, improves as site changes (except restricted)
                try {
                    var themeData = data.config.theme;
                    var customerBase = data.config.customerBase;
                    // also try dedicated theme endpoint for fresher data (site may have changed since config)
                    api("/api/v1/widget/theme",{method:"GET"}).then(function(td){
                        if(td && td.theme) themeData = td.theme;
                        if(td && td.customerBase) customerBase = td.customerBase;
                        applyWidgetTheme(themeData, customerBase);
                    }).catch(function(){ if(themeData) applyWidgetTheme(themeData, customerBase); });
                    // fallback: apply immediately from config
                    if(themeData) applyWidgetTheme(themeData, customerBase);
                    // also adapt welcome tone to customer base
                    if(customerBase && customerBase.indexOf("fashion")!==-1 && data.config.welcomeMessage){
                        // keep welcome but note fashion tone — widget will be more style-aware
                    }
                } catch {}
                // poll for theme changes as site evolves (every 5 min, widget improves)
                try {
                    if(!window._novaThemeInterval){
                        window._novaThemeInterval = setInterval(function(){
                            api("/api/v1/widget/theme",{method:"GET"}).then(function(td){
                                if(td && td.theme) applyWidgetTheme(td.theme, td.customerBase);
                            }).catch(function(){});
                        }, 300000);
                    }
                } catch {}
            }
            configLoaded = true;
            if (data.config && data.config.welcomeMessage && !hasWelcomed) {
                var alreadyHasWelcome = false;
                if (messagesEl) {
                    for (var i = 0; i < messagesEl.children.length; i++) {
                        if (messagesEl.children[i].textContent === data.config.welcomeMessage) {
                            alreadyHasWelcome = true;
                            break;
                        }
                    }
                }
                if (!alreadyHasWelcome && messages.length === 0) {
                    addMessage("assistant", data.config.welcomeMessage);
                    messages.push({ role: "assistant", content: data.config.welcomeMessage });
                    hasWelcomed = true;
                } else if (alreadyHasWelcome) {
                    hasWelcomed = true;
                }
            }
        } catch (error) {
            console.warn("NOVA Widget:", error.message);
        }
    }

    function escapeHtml(str) {
        return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }
    function formatMessage(content) {
        // Escape then render **bold** as <strong>, *italic* as <em>, and preserve line breaks via pre-wrap
        var escaped = escapeHtml(content);
        // **bold** (non-greedy, allow spaces)
        escaped = escaped.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
        // *italic* (avoid matching **)
        escaped = escaped.replace(/(^|[^*])\*([^*\n]+?)\*([^*]|$)/g, function (m, p1, p2, p3) { return p1 + "<em>" + p2 + "</em>" + p3; });
        return escaped;
    }
    function addMessage(role, content) {
        if (!messagesEl) return;
        var element = document.createElement("div");
        element.className = "nova-msg " + role;
        // Render markdown bold/italic as HTML (already escaped), keep pre-wrap for line breaks
        element.innerHTML = formatMessage(content);
        messagesEl.appendChild(element);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return element;
    }

    function maybeGuideIntent(text){
        // guide overlay is NOT triggered by chat anymore — only auto on first login visit (see loadConfig)
        // keep helper for legacy but never auto-start guide here
        return false;
    }
    function maybeNavigateIntent(text){
        var t = String(text||"").toLowerCase();
        var m = t.match(/guide me to (?:the )?(\w+)/);
        if(m){
            var target = (m[1]||"").toLowerCase();
            var map = { features:"features.html", pricing:"pricing.html", home:"index.html", checkout:"checkout.html", login:"login.html", featureshtml:"features.html" };
            if(map[target]) return map[target];
            // also handle "features section" -> features.html
            if(target==="features" || target==="feature") return "features.html";
            if(target==="pricing" || target==="price") return "pricing.html";
            return null;
        }
        // also handle direct "open features" etc.
        if(/open (features|pricing|home)/.test(t)){
            var mm = t.match(/open (features|pricing|home)/);
            var tgt = mm?mm[1]:"";
            if(tgt==="features") return "features.html";
            if(tgt==="pricing") return "pricing.html";
            if(tgt==="home") return "index.html";
        }
        return null;
    }
    function genericGuideSteps(){
        return [
            { id:"welcome", title:"Welcome — I'll guide you", selector:"body", description:"Hi, I'm NOVA. I'll show you around in 60 seconds.", position:"center" },
            { id:"explore", title:"Explore", selector:"nav, header", description:"Browse what's here — I'll explain as we go.", position:"bottom" },
            { id:"talk", title:"Ask me anything on NOVA", selector:"#nova-widget-button", description:"Guide done. Ask any question — I still handle basics like support, sales, bookings.", position:"left" }
        ];
    }
    async function sendMessage() {
        var text = (inputEl.value || "").trim();
        if (!text || busy) return;

        // navigation intent: "guide me to features" -> open that section, not guide overlay
        var navTarget = maybeNavigateIntent(text);
        if(navTarget){
            inputEl.value = "";
            addMessage("user", text);
            messages.push({ role: "user", content: text });
            addMessage("assistant", "Opening "+navTarget.replace(".html","")+" for you — taking you there.");
            messages.push({ role: "assistant", content: "Opening "+navTarget });
            setTimeout(function(){
                try{
                    // if same page section, scroll; else navigate
                    if(navTarget.indexOf("features")!==-1){
                        // if on index, scroll to bento, else go to features.html
                        var bento = document.querySelector(".bento");
                        if(bento && window.location.pathname.indexOf("features")===-1 && window.location.pathname.indexOf("index")!==-1){
                            bento.scrollIntoView({behavior:"smooth", block:"start"});
                        } else {
                            window.location.href = navTarget;
                        }
                    } else {
                        window.location.href = navTarget;
                    }
                } catch(e){ window.location.href = navTarget; }
            }, 600);
            return;
        }

        inputEl.value = "";
        addMessage("user", text);
        messages.push({ role: "user", content: text });
        busy = true;
        sendEl.disabled = true;

        var loading = addMessage("assistant", "...");
        loading.className = "nova-msg nova-loading";

        try {
            var data = await api("/api/v1/widget/chat", {
                method: "POST",
                body: JSON.stringify({
                    customerId: getVisitorId(),
                    conversationId: conversationId,
                    messages: messages.slice(-30)
                })
            });

            loading.remove();
            conversationId = data.conversationId || conversationId;

            var reply = data.reply || "Sorry, I could not generate a response.";
            // handle server-side navigation intent [NAVIGATE:features.html]
            var navMatch = reply.match(/\[NAVIGATE:([^\]]+)\]/);
            if(navMatch){
                var target = navMatch[1].trim();
                reply = reply.replace(/\[NAVIGATE:[^\]]+\]/g, "").trim();
                if(!reply) reply = "Opening "+target.replace(".html","")+" for you — taking you there.";
            }
            addMessage("assistant", reply);
            messages.push({ role: "assistant", content: reply });
            if(navMatch){
                try{
                    setTimeout(function(){
                        var tgt = navMatch[1].trim();
                        if(tgt.indexOf("features")!==-1){
                            var bento = document.querySelector(".bento");
                            if(bento && window.location.pathname.indexOf("features")===-1){
                                bento.scrollIntoView({behavior:"smooth", block:"start"});
                                return;
                            }
                        }
                        window.location.href = tgt;
                    }, 800);
                } catch{}
            }
        } catch (error) {
            loading.remove();
            addMessage("assistant", error.message || "Something went wrong.");
        } finally {
            busy = false;
            sendEl.disabled = false;
            inputEl.focus();
        }
    }

    function toggle() {
        widget.classList.toggle("open");
        if (widget.classList.contains("open")) {
            if (inputEl) inputEl.focus();
            if (!hasWelcomed) loadConfig();
        }
    }

    // ── chrono: ranked availability (cached 60s for speed) ──
    async function toggleAvailability() {
        availOpen = !availOpen;
        if (!availPanel) return;
        availPanel.classList.toggle("open", availOpen);
        if (availOpen) {
            // Use cache if fresh (60s) to avoid refetch on every toggle
            if (availCache && (Date.now() - availCacheAt) < 60000) {
                renderAvailability(availCache);
                return;
            }
            availPanel.textContent = "Loading availability…";
            try {
                var data = await api("/api/v1/widget/availability?days=14");
                availCache = data.availability;
                availCacheAt = Date.now();
                renderAvailability(availCache);
                return;
            } catch (e) {
                availPanel.textContent = e.message;
                return;
            }
        }
    }
    function renderAvailability(avail) {
        try {
            if (!avail || !avail.days || !avail.days.length) {
                availPanel.textContent = "No availability in the next 2 weeks.";
                return;
            }
            availPanel.innerHTML = avail.days.map(function (day) {
                if (!day.openSlots.length) return '<div style="padding:4px 0;color:#9ca3af">' + day.date + ' — closed</div>';
                var slots = day.openSlots.slice(0, 6).map(function (t) {
                    return '<span class="nova-slot" data-iso="' + day.date + "T" + t + ':00Z">' + t + "</span>";
                }).join("");
                return '<div style="padding:4px 0"><b>' + day.date + "</b> " + slots + "</div>";
            }).join("");
            availPanel.querySelectorAll(".nova-slot").forEach(function (el) {
                el.addEventListener("click", function () {
                    var iso = el.getAttribute("data-iso");
                    inputEl.value = "I'd like to book for " + iso.replace("T", " ").replace("Z", " UTC");
                    availPanel.classList.remove("open");
                    availOpen = false;
                    inputEl.focus();
                });
            });
        } catch (e) {
            availPanel.textContent = e.message;
        }
    }

    // ── echo: voice input ──
    async function toggleMic() {
        if (recording) { stopMic(); return; }
        startMic();
    }

    async function startMic() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            // Fallback to browser SpeechRecognition if available
            if (window.SpeechRecognition || window.webkitSpeechRecognition) {
                try {
                    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
                    var rec = new SR();
                    rec.lang = multilanguageEnabled ? "" : "en-US";
                    rec.interimResults = false;
                    rec.maxAlternatives = 1;
                    var srLoading = addMessage("assistant", "Listening…");
                    if (srLoading) srLoading.className = "nova-msg nova-loading";
                    rec.onresult = async function (ev) {
                        if (srLoading) srLoading.remove();
                        var transcript = ev.results && ev.results[0] && ev.results[0][0] ? ev.results[0][0].transcript : "";
                        if (!transcript) { addMessage("assistant", "Didn't catch that — please try again or type."); return; }
                        addMessage("user", transcript);
                        messages.push({ role: "user", content: transcript });
                        busy = true;
                        if (sendEl) sendEl.disabled = true;
                        var cl = addMessage("assistant", "...");
                        if (cl) cl.className = "nova-msg nova-loading";
                        try {
                            var cd = await api("/api/v1/widget/chat", {method:"POST", body:JSON.stringify({customerId:getVisitorId(), conversationId:conversationId, messages:messages.slice(-30)})});
                            if (cl) cl.remove();
                            conversationId = cd.conversationId || conversationId;
                            var reply2=cd.reply||"";
                            addMessage("assistant", reply2);
                            messages.push({role:"assistant", content: reply2});
                            try{ var tts2=await api("/api/v1/tts/synthesize",{method:"POST", body:JSON.stringify({text:reply2, language: multilanguageEnabled?"auto":"en"})}).catch(function(){return null}); if(tts2&&tts2.audioBase64){ var a2=new Audio("data:audio/mp3;base64,"+tts2.audioBase64); a2.play().catch(function(){ tryBrowserTTS(reply2, multilanguageEnabled?"auto":"en"); }); } else { tryBrowserTTS(reply2, multilanguageEnabled?"auto":"en"); } }catch{ tryBrowserTTS(reply2, "en"); }
                        } catch (e) { if (cl) cl.remove(); addMessage("assistant", e.message || "Chat failed."); }
                        finally { busy = false; if (sendEl) sendEl.disabled = false; if (inputEl) inputEl.focus(); }
                    };
                    rec.onerror = function () { if (srLoading) srLoading.remove(); addMessage("assistant", "Voice recognition failed — please type."); };
                    rec.onend = function () { if (srLoading && srLoading.parentNode) srLoading.remove(); };
                    rec.start();
                    return;
                } catch (e) {}
            }
            addMessage("assistant", "Voice input not supported in this browser.");
            return;
        }
        // If sidecar not available on prod Vercel (or unknown but not localhost), use browser STT directly — 100% guarantee, no server/wasm
        var isLocalHost = location.hostname==="localhost" || location.hostname==="127.0.0.1";
        if ((sidecarAvailable === false || (sidecarAvailable === null && !isLocalHost)) && (window.SpeechRecognition || window.webkitSpeechRecognition)) {
            try{
                var SR2 = window.SpeechRecognition || window.webkitSpeechRecognition;
                var rec2 = new SR2();
                rec2.lang = multilanguageEnabled ? "" : "en-US";
                rec2.interimResults = false;
                rec2.maxAlternatives = 1;
                var srLoading2 = addMessage("assistant", "Listening…");
                if(srLoading2) srLoading2.className = "nova-msg nova-loading";
                rec2.onresult = async function(ev){
                    if(srLoading2) srLoading2.remove();
                    var transcript = ev.results && ev.results[0] && ev.results[0][0] ? ev.results[0][0].transcript : "";
                    if(!transcript){ addMessage("assistant", "Didn't catch that — please try again or type."); return; }
                    // handle navigation locally like typed
                    var navT = maybeNavigateIntent(transcript);
                    if(navT){
                        addMessage("user", transcript);
                        messages.push({role:"user", content:transcript});
                        addMessage("assistant", "Opening "+navT.replace(".html","")+" for you — taking you there.");
                        messages.push({role:"assistant", content:"Opening "+navT});
                        tryBrowserTTS("Opening "+navT.replace(".html","")+" for you", "en");
                        setTimeout(function(){ try{ window.location.href = navT; }catch(e){} }, 600);
                        return;
                    }
                    addMessage("user", transcript);
                    messages.push({ role: "user", content: transcript });
                    busy = true; if(sendEl) sendEl.disabled = true;
                    var cl2 = addMessage("assistant", "...");
                    if(cl2) cl2.className = "nova-msg nova-loading";
                    try{
                        var cd2 = await api("/api/v1/widget/chat", {method:"POST", body:JSON.stringify({customerId:getVisitorId(), conversationId:conversationId, messages:messages.slice(-30)})});
                        if(cl2) cl2.remove();
                        conversationId = cd2.conversationId || conversationId;
                        var reply2b=cd2.reply||"";
                        var navM2 = reply2b.match(/\[NAVIGATE:([^\]]+)\]/);
                        if(navM2){ var tgt2=navM2[1].trim(); reply2b=reply2b.replace(/\[NAVIGATE:[^\]]+\]/g,"").trim(); if(!reply2b) reply2b="Opening "+tgt2.replace(".html","")+" for you — taking you there."; }
                        addMessage("assistant", reply2b);
                        messages.push({role:"assistant", content: reply2b});
                        if(navM2){ try{ setTimeout(function(){ window.location.href = navM2[1].trim(); },800); }catch{} }
                        try{ var tts2b=await api("/api/v1/tts/synthesize",{method:"POST", body:JSON.stringify({text:reply2b, language: multilanguageEnabled?"auto":"en"})}).catch(function(){return null}); if(tts2b&&tts2b.audioBase64){ var a2b=new Audio("data:audio/mp3;base64,"+tts2b.audioBase64); a2b.play().catch(function(){ tryBrowserTTS(reply2b, multilanguageEnabled?"auto":"en"); }); } else { tryBrowserTTS(reply2b, multilanguageEnabled?"auto":"en"); } }catch{ tryBrowserTTS(reply2b, "en"); }
                    } catch(e2){ if(cl2) cl2.remove(); addMessage("assistant", e2.message || "Chat failed."); }
                    finally{ busy=false; if(sendEl) sendEl.disabled=false; if(inputEl) inputEl.focus(); }
                };
                rec2.onerror = function(){ if(srLoading2) srLoading2.remove(); addMessage("assistant", "Voice recognition failed — please type."); };
                rec2.onend = function(){ if(srLoading2 && srLoading2.parentNode) srLoading2.remove(); };
                rec2.start();
                return;
            }catch(e){}
        }
        var stream = null;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            audioChunks = [];
            var mime = (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) ? "audio/webm;codecs=opus" : "audio/webm";
            mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
            mediaRecorder.ondataavailable = function (e) { if (e.data && e.data.size) audioChunks.push(e.data); };
            mediaRecorder.onstop = async function () {
                try {
                    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
                    var blob = new Blob(audioChunks, { type: mime });
                    if (!blob.size) { addMessage("assistant", "No audio captured. Please try again or type."); return; }
                    // Ensure FileReader exists (jsdom fallback)
                    if (typeof FileReader === "undefined") {
                        addMessage("assistant", "Voice captured (" + blob.size + " bytes) — transcribing via browser. Please type your message for now.");
                        return;
                    }
                    var loading = addMessage("assistant", "Transcribing…");
                    if (loading) loading.className = "nova-msg nova-loading";
                    busy = true; if (sendEl) sendEl.disabled = true;
                    // Convert to wav when possible so sidecar (no ffmpeg) can decode reliably — guarantees 100% STT
                    blobToWavBase64(blob, async function(base64Wav, wavMime){
                        var base64 = base64Wav;
                        var mimeToSend = wavMime || mime;
                        // Fallback to original FileReader if conversion failed
                        if(!base64){
                            try{
                                var fr = new FileReader();
                                fr.onload = async function(){
                                    try{ base64 = String(fr.result).split(",")[1]||""; }catch(e){ if(loading) loading.remove(); addMessage("assistant","Audio read failed — please type."); busy=false; if(sendEl) sendEl.disabled=false; return; }
                                    await doTranscribe(base64, mime);
                                };
                                fr.onerror = function(){ if(loading) loading.remove(); addMessage("assistant","Failed to read audio — please type."); busy=false; if(sendEl) sendEl.disabled=false; };
                                fr.readAsDataURL(blob);
                                return;
                            }catch(e){ if(loading) loading.remove(); addMessage("assistant","Audio read failed — please type."); busy=false; if(sendEl) sendEl.disabled=false; return; }
                        } else {
                            await doTranscribe(base64, mimeToSend);
                        }
                        async function doTranscribe(base64, mimeArg){
                        try {
                            // let Echo auto-detect any of 100+ langs when multilanguage on, else default
                            var tLang = multilanguageEnabled ? "auto" : (voiceEnabled ? "auto" : "en");
                            var data = await api("/api/v1/widget/transcribe", {
                                method: "POST",
                                body: JSON.stringify({ audioBase64: base64, mimeType: mimeArg, customerId: getVisitorId(), conversationId: conversationId, language: tLang })
                            });
                            if (loading) loading.remove();
                            var text = data.text || data.transcript || "";
                            var lang = data.language || tLang || "auto";
                            if (!text) {
                                // server returned empty (sidecar not available on Vercel or silence) — try browser wasm, then SpeechRecognition
                                var wasmText = "";
                                try{
                                    if(loading) loading.textContent = "Transcribing (browser)…";
                                    wasmText = await transcribeWithWasm(blob);
                                }catch(e){}
                                if(wasmText && wasmText.trim()){
                                    text = wasmText.trim();
                                    lang = "en";
                                    if(loading) loading.textContent = "Transcribing…";
                                } else {
                                    // wasm failed or still empty — try native SpeechRecognition as final fallback (no download)
                                    var srText = "";
                                    try{
                                        if(loading) loading.textContent = "Listening (browser)…";
                                        srText = await transcribeWithSpeechRecognitionOnce();
                                    }catch(e){}
                                    if(srText && srText.trim()){
                                        text = srText.trim();
                                        lang = "en";
                                    } else {
                                        text = data.message || "Voice captured — server STT unavailable. Please type your message or allow mic for browser STT.";
                                        addMessage("assistant", text);
                                        return;
                                    }
                                }
                            }
                            // voice navigation — handle "guide me to X" locally before server, like typed sendMessage does
                            var navTargetVoice = maybeNavigateIntent(text);
                            if(navTargetVoice){
                                addMessage("user", text + (lang && lang!=="en" ? " ["+lang+"]" : ""));
                                messages.push({ role: "user", content: text });
                                if (loading) loading.remove();
                                addMessage("assistant", "Opening "+navTargetVoice.replace(".html","")+" for you — taking you there.");
                                messages.push({ role: "assistant", content: "Opening "+navTargetVoice });
                                tryBrowserTTS("Opening "+navTargetVoice.replace(".html","")+" for you", lang);
                                setTimeout(function(){
                                    try{
                                        if(navTargetVoice.indexOf("features")!==-1){
                                            var bento = document.querySelector(".bento");
                                            if(bento && window.location.pathname.indexOf("features")===-1 && window.location.pathname.indexOf("index")===-1){
                                                bento.scrollIntoView({behavior:"smooth", block:"start"});
                                            } else {
                                                window.location.href = navTargetVoice;
                                            }
                                        } else {
                                            window.location.href = navTargetVoice;
                                        }
                                    }catch(e){ window.location.href = navTargetVoice; }
                                }, 600);
                                return;
                            }
                            // inject transcript as user message and send on their behalf — Nova AI + OpenAI see it as normal chat in detected language
                            addMessage("user", text + (lang && lang!=="en" ? " ["+lang+"]" : ""));
                            messages.push({ role: "user", content: text });
                            var chatLoading = addMessage("assistant", "...");
                            if (chatLoading) chatLoading.className = "nova-msg nova-loading";
                            var chatData = await api("/api/v1/widget/chat", {
                                method: "POST",
                                body: JSON.stringify({ customerId: getVisitorId(), conversationId: conversationId, messages: messages.slice(-30) })
                            });
                            if (chatLoading) chatLoading.remove();
                            conversationId = chatData.conversationId || conversationId;
                            var reply = chatData.reply || "";
                            // handle server-side navigation [NAVIGATE:features.html] — same as sendMessage
                            var navMatch = reply.match(/\[NAVIGATE:([^\]]+)\]/);
                            if(navMatch){
                                var target = navMatch[1].trim();
                                reply = reply.replace(/\[NAVIGATE:[^\]]+\]/g, "").trim();
                                if(!reply) reply = "Opening "+target.replace(".html","")+" for you — taking you there.";
                            }
                            addMessage("assistant", reply);
                            messages.push({ role: "assistant", content: reply });
                            if(navMatch){
                                try{
                                    setTimeout(function(){
                                        var tgt = navMatch[1].trim();
                                        if(tgt.indexOf("features")!==-1){
                                            var bento2 = document.querySelector(".bento");
                                            if(bento2 && window.location.pathname.indexOf("features")===-1){
                                                bento2.scrollIntoView({behavior:"smooth", block:"start"});
                                                return;
                                            }
                                        }
                                        window.location.href = tgt;
                                    }, 800);
                                }catch{}
                            }
                            // speak reply via TTS in same language — Echo 24/7 (piper/openai) + browser fallback guarantee
                            try{
                                var ttsLang = lang && lang!=="auto" ? lang : (multilanguageEnabled ? (data.language||"auto") : "en");
                                var ttsRes = await api("/api/v1/tts/synthesize",{method:"POST", body:JSON.stringify({text:reply, language:ttsLang})}).catch(function(){return null});
                                if(ttsRes && ttsRes.audioBase64){
                                    var audio = new Audio("data:audio/mp3;base64,"+ttsRes.audioBase64);
                                    audio.play().catch(function(){ tryBrowserTTS(reply, ttsLang); });
                                } else {
                                    tryBrowserTTS(reply, ttsLang);
                                }
                            }catch{ tryBrowserTTS(reply, lang); }
                        } catch (e) {
                            // Server transcribe failed (timeout / network) — try browser wasm STT
                            var wasmText2 = "";
                            try{
                                if(loading) loading.textContent = "Transcribing (browser)…";
                                wasmText2 = await transcribeWithWasm(blob);
                            }catch(ee){}
                            if(wasmText2 && wasmText2.trim()){
                                if(loading) loading.remove();
                                var text2 = wasmText2.trim();
                                var lang2 = "en";
                                var navTargetVoice2 = maybeNavigateIntent(text2);
                                if(navTargetVoice2){
                                    addMessage("user", text2);
                                    messages.push({ role: "user", content: text2 });
                                    addMessage("assistant", "Opening "+navTargetVoice2.replace(".html","")+" for you — taking you there.");
                                    messages.push({ role: "assistant", content: "Opening "+navTargetVoice2 });
                                    tryBrowserTTS("Opening "+navTargetVoice2.replace(".html","")+" for you", lang2);
                                    setTimeout(function(){ try{ window.location.href = navTargetVoice2; }catch(e){} }, 600);
                                    return;
                                }
                                addMessage("user", text2);
                                messages.push({ role: "user", content: text2 });
                                var chatLoading2 = addMessage("assistant", "...");
                                if(chatLoading2) chatLoading2.className = "nova-msg nova-loading";
                                try{
                                    var chatData2 = await api("/api/v1/widget/chat", {
                                        method: "POST",
                                        body: JSON.stringify({ customerId: getVisitorId(), conversationId: conversationId, messages: messages.slice(-30) })
                                    });
                                    if(chatLoading2) chatLoading2.remove();
                                    conversationId = chatData2.conversationId || conversationId;
                                    var reply2 = chatData2.reply || "";
                                    var navMatch2 = reply2.match(/\[NAVIGATE:([^\]]+)\]/);
                                    if(navMatch2){
                                        var target2 = navMatch2[1].trim();
                                        reply2 = reply2.replace(/\[NAVIGATE:[^\]]+\]/g, "").trim();
                                        if(!reply2) reply2 = "Opening "+target2.replace(".html","")+" for you — taking you there.";
                                    }
                                    addMessage("assistant", reply2);
                                    messages.push({ role: "assistant", content: reply2 });
                                    if(navMatch2){
                                        try{ setTimeout(function(){ window.location.href = navMatch2[1].trim(); }, 800); }catch{}
                                    }
                                    try{
                                        var ttsLang2 = lang2 && lang2!=="auto" ? lang2 : "en";
                                        var ttsRes2 = await api("/api/v1/tts/synthesize",{method:"POST", body:JSON.stringify({text:reply2, language:ttsLang2})}).catch(function(){return null});
                                        if(ttsRes2 && ttsRes2.audioBase64){
                                            var audio2 = new Audio("data:audio/mp3;base64,"+ttsRes2.audioBase64);
                                            audio2.play().catch(function(){ tryBrowserTTS(reply2, ttsLang2); });
                                        } else { tryBrowserTTS(reply2, ttsLang2); }
                                    }catch{ tryBrowserTTS(reply2, lang2); }
                                } catch(err2){
                                    if(chatLoading2) chatLoading2.remove();
                                    addMessage("assistant", err2.message || "Chat failed.");
                                }
                                return;
                            }
                            // wasm failed — try native SpeechRecognition as final fallback (no download)
                            var srText2 = "";
                            try{
                                if(loading) loading.textContent = "Listening (browser)…";
                                srText2 = await transcribeWithSpeechRecognitionOnce();
                            }catch(ee){}
                            if(srText2 && srText2.trim()){
                                if(loading) loading.remove();
                                var text3 = srText2.trim();
                                var lang3 = "en";
                                var navTargetVoice3 = maybeNavigateIntent(text3);
                                if(navTargetVoice3){
                                    addMessage("user", text3);
                                    messages.push({ role: "user", content: text3 });
                                    addMessage("assistant", "Opening "+navTargetVoice3.replace(".html","")+" for you — taking you there.");
                                    messages.push({ role: "assistant", content: "Opening "+navTargetVoice3 });
                                    tryBrowserTTS("Opening "+navTargetVoice3.replace(".html","")+" for you", lang3);
                                    setTimeout(function(){ try{ window.location.href = navTargetVoice3; }catch(e){} }, 600);
                                    return;
                                }
                                addMessage("user", text3);
                                messages.push({ role: "user", content: text3 });
                                var chatLoading3 = addMessage("assistant", "...");
                                if(chatLoading3) chatLoading3.className = "nova-msg nova-loading";
                                try{
                                    var chatData3 = await api("/api/v1/widget/chat", {
                                        method: "POST",
                                        body: JSON.stringify({ customerId: getVisitorId(), conversationId: conversationId, messages: messages.slice(-30) })
                                    });
                                    if(chatLoading3) chatLoading3.remove();
                                    conversationId = chatData3.conversationId || conversationId;
                                    var reply3 = chatData3.reply || "";
                                    var navMatch3 = reply3.match(/\[NAVIGATE:([^\]]+)\]/);
                                    if(navMatch3){
                                        var target3 = navMatch3[1].trim();
                                        reply3 = reply3.replace(/\[NAVIGATE:[^\]]+\]/g, "").trim();
                                        if(!reply3) reply3 = "Opening "+target3.replace(".html","")+" for you — taking you there.";
                                    }
                                    addMessage("assistant", reply3);
                                    messages.push({ role: "assistant", content: reply3 });
                                    if(navMatch3){
                                        try{ setTimeout(function(){ window.location.href = navMatch3[1].trim(); }, 800); }catch{}
                                    }
                                    try{
                                        var ttsLang3 = lang3;
                                        var ttsRes3 = await api("/api/v1/tts/synthesize",{method:"POST", body:JSON.stringify({text:reply3, language:ttsLang3})}).catch(function(){return null});
                                        if(ttsRes3 && ttsRes3.audioBase64){
                                            var audio3 = new Audio("data:audio/mp3;base64,"+ttsRes3.audioBase64);
                                            audio3.play().catch(function(){ tryBrowserTTS(reply3, ttsLang3); });
                                        } else { tryBrowserTTS(reply3, ttsLang3); }
                                    }catch{ tryBrowserTTS(reply3, lang3); }
                                } catch(err3){
                                    if(chatLoading3) chatLoading3.remove();
                                    addMessage("assistant", err3.message || "Chat failed.");
                                }
                                return;
                            }
                            if (loading) loading.remove();
                            addMessage("assistant", e.message || "Transcription failed. Please type your message.");
                        } finally {
                            busy = false; if (sendEl) sendEl.disabled = false; if (inputEl) inputEl.focus();
                        }
                    }
                    });
                } catch (e) {
                    if (loading) loading.remove();
                    addMessage("assistant", "Voice processing failed — please type your message.");
                    busy = false; if (sendEl) sendEl.disabled = false;
                } finally {
                    // ensure mic resets even if FileReader setup fails
                    recording = false;
                    if (micEl) { micEl.classList.remove("on"); micEl.textContent = "🎙"; }
                    if (!busy) { busy = false; if (sendEl) sendEl.disabled = false; }
                }
            };
            mediaRecorder.start();
            recording = true;
            if (micEl) { micEl.classList.add("on"); micEl.textContent = "■"; }
        } catch (e) {
            addMessage("assistant", "Microphone permission denied. Please check browser permissions or type your message.");
            recording = false;
            if (micEl) { micEl.classList.remove("on"); micEl.textContent = "🎙"; }
            busy = false; if (sendEl) sendEl.disabled = false;
        }
    }

    function stopMic() {
        if (mediaRecorder && recording) {
            try { mediaRecorder.stop(); } catch {}
        }
        recording = false;
        if (micEl) { micEl.classList.remove("on"); micEl.textContent = "🎙"; }
    }

    function toggleLegacy() { toggle(); }

    // --- proactive engagement (growth suite) ---------------------------------
    var proactiveFired = false;
    function maybeProactive() {
        if (proactiveFired || widget.classList.contains("open")) return;
        try {
            var intent = window.NOVATracker && typeof window.NOVATracker.lastIntent === "function" ? window.NOVATracker.lastIntent() : null;
            if (!intent) return;
            proactiveFired = true;
            // suppress the generic welcome when proactive opens — show only the intent
            if (!hasWelcomed) hasWelcomed = true;
            toggle();
            // ensure config is loaded for title/voice, but don't add welcome again
            loadConfig().then(function () {
                // avoid duplicate intent if already shown
                var alreadyShown = messages.some(function (m) { return m.content === intent.message; });
                if (!alreadyShown) {
                    addMessage("assistant", intent.message);
                    messages.push({ role: "assistant", content: intent.message });
                }
            });
        } catch (e) { /* never break the host page */ }
    }

    setTimeout(function () {
        document.addEventListener("mouseout", function (event) {
            if (!event.relatedTarget && event.clientY <= 0) maybeProactive();
        }, { passive: true });

        var idleTimer = null;
        function resetIdle() {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(maybeProactive, 45000);
        }
        ["mousemove", "keydown", "scroll", "touchstart"].forEach(function (evt) {
            document.addEventListener(evt, resetIdle, { passive: true });
        });
        resetIdle();
        document.addEventListener("nova:intent", maybeProactive);
    }, 4000);

    window.NOVA_WIDGET = Object.assign(window.NOVA_WIDGET || {}, {
        open: toggle,
        proactive: maybeProactive,
        toggleAvailability: toggleAvailability,
        captureEmail: function (email, name) {
            try {
                return api("/api/v1/customers/" + encodeURIComponent(getVisitorId()), {
                    method: "PATCH",
                    body: JSON.stringify({ email: email, name: name }),
                }).then(function () { return true; }).catch(function () { return false; });
            } catch (e) { return Promise.resolve(false); }
        },
        requestHandoff: function (reason) {
            return api("/api/v1/widget/call/handoff", {
                method: "POST",
                body: JSON.stringify({ customerId: getVisitorId(), reason: reason || "Customer requested human" })
            });
        }
    });
})();

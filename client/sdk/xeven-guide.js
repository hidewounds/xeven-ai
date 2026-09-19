// XEVEN GUIDE — full operation website guide overlay, points at real elements
// Loaded on demand by xeven-widget.js via XEVEN_GUIDE.start(steps)
(function(){
  "use strict";
  var overlay=null, tooltip=null, arrow=null, current=0, steps=[], onClose=null;
  function ensure(){
    if(overlay) return;
    var s=document.createElement("style");
    s.textContent=[
      "#xeven-guide-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2147482998;display:none}",
      "#xeven-guide-overlay.on{display:block}",
      ".xeven-guide-highlight{position:absolute;border:2px solid #8b5cf6;border-radius:10px;box-shadow:0 0 0 9999px rgba(0,0,0,.55), 0 8px 32px rgba(139,92,246,.35);background:rgba(139,92,246,.08);transition:all .35s cubic-bezier(.16,1,.3,1);z-index:2147482999;pointer-events:none}",
      "#xeven-guide-tooltip{position:absolute;z-index:2147483000;background:linear-gradient(180deg, rgba(255,255,255,.96), rgba(255,255,255,.92));backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.6);border-radius:14px;padding:14px 16px;max-width:320px;box-shadow:0 20px 50px rgba(0,0,0,.25);font-family:Inter,'Instrument Sans',system-ui,sans-serif;color:#111}",
      "#xeven-guide-tooltip h4{margin:0 0 6px;font:700 14px 'Space Grotesk',sans-serif;letter-spacing:-.01em}",
      "#xeven-guide-tooltip p{margin:0;font:400 13px/1.5 'Instrument Sans',sans-serif;color:#475569}",
      "#xeven-guide-tooltip .actions{display:flex;gap:8px;margin-top:12px;align-items:center}",
      "#xeven-guide-tooltip button{border:1px solid rgba(0,0,0,.08);border-radius:999px;padding:7px 14px;font:600 13px 'Instrument Sans',sans-serif;cursor:pointer}",
      "#xeven-guide-tooltip .primary{background:linear-gradient(135deg,#8b5cf6,#6366f1);color:#fff;border-color:transparent}",
      "#xeven-guide-tooltip .muted{color:#64748b;font-size:12px;margin-left:auto}",
      "#xeven-guide-arrow{position:absolute;width:14px;height:14px;background:#fff;border-left:1px solid rgba(0,0,0,.06);border-top:1px solid rgba(0,0,0,.06);transform:rotate(45deg);z-index:2147483000;display:none}"
    ].join("\n");
    document.head.appendChild(s);
    overlay=document.createElement("div"); overlay.id="xeven-guide-overlay";
    overlay.innerHTML='<div class="xeven-guide-highlight" id="xeven-guide-highlight"></div><div id="xeven-guide-tooltip"><h4 id="xeven-guide-title"></h4><p id="xeven-guide-desc"></p><div class="actions"><button id="xeven-guide-prev">Back</button><button id="xeven-guide-next" class="primary">Next</button><span class="muted" id="xeven-guide-progress"></span><button id="xeven-guide-close" style="margin-left:4px">✕</button></div></div><div id="xeven-guide-arrow"></div>';
    document.body.appendChild(overlay);
    overlay.querySelector("#xeven-guide-next").addEventListener("click", function(){ next(1); });
    overlay.querySelector("#xeven-guide-prev").addEventListener("click", function(){ next(-1); });
    overlay.querySelector("#xeven-guide-close").addEventListener("click", close);
    overlay.addEventListener("click", function(e){ if(e.target===overlay) close(); });
  }
  function resolveTarget(selector){
    if(!selector || selector==="body") return document.body;
    // handle :contains pseudo (our steps use it)
    if(selector.indexOf(":contains")!==-1){
      var parts=selector.split(","); 
      for(var i=0;i<parts.length;i++){
        var p=parts[i].trim();
        var m=p.match(/:contains\(['"]?([^'")]+)['"]?\)/);
        if(m){
          var txt=m[1].toLowerCase();
          var base=p.replace(/:contains\(['"]?[^'"]+['"]?\)/,"").trim()||"*";
          var els=document.querySelectorAll(base);
          for(var k=0;k<els.length;k++){ if(els[k].textContent.toLowerCase().indexOf(txt)!==-1) return els[k]; }
        } else {
          try{ var el=document.querySelector(p); if(el) return el; }catch(e){}
        }
      }
      return document.body;
    }
    // comma list fallback
    var list=selector.split(",");
    for(var j=0;j<list.length;j++){ try{ var e=document.querySelector(list[j].trim()); if(e) return e; }catch(e){} }
    return document.body;
  }
  function position(step){
    var target=resolveTarget(step.selector);
    var hl=document.getElementById("xeven-guide-highlight");
    var tt=document.getElementById("xeven-guide-tooltip");
    var ar=document.getElementById("xeven-guide-arrow");
    if(!hl||!tt) return;
    var r = target===document.body ? {left: window.innerWidth/2-160, top: window.innerHeight/2-80, width:320, height:160 } : target.getBoundingClientRect();
    // highlight
    hl.style.left=(r.left-6)+"px"; hl.style.top=(r.top-6)+"px"; hl.style.width=(r.width+12)+"px"; hl.style.height=(r.height+12)+"px";
    // tooltip position: try bottom, then top, then center
    var tr=tt.getBoundingClientRect();
    var left=Math.min(Math.max(12, r.left + r.width/2 - tr.width/2), window.innerWidth - tr.width - 12);
    var top;
    if(step.position==="top" && r.top - tr.height - 18 > 12) top=r.top - tr.height - 18;
    else if(step.position==="bottom" && r.top + r.height + 18 + tr.height < window.innerHeight) top=r.top + r.height + 18;
    else if(step.position==="left" && r.left - tr.width - 18 > 12) { left=r.left - tr.width - 18; top=r.top + r.height/2 - tr.height/2; }
    else if(r.top + r.height + 18 + tr.height < window.innerHeight) top=r.top + r.height + 18;
    else top=Math.max(12, r.top - tr.height - 18);
    tt.style.left=left+"px"; tt.style.top=top+"px";
    // arrow from tooltip to target
    var tx= r.left + r.width/2, ty= r.top + r.height/2;
    var ttx= left + tr.width/2, tty= top + tr.height/2;
    // simple: arrow at edge of tooltip closest to target
    var ax, ay;
    if(top < r.top) { ax= Math.min(Math.max(left+16, tx-7), left+tr.width-16); ay= top + tr.height - 7; ar.style.transform="rotate(45deg)"; }
    else if(top > r.top) { ax= Math.min(Math.max(left+16, tx-7), left+tr.width-16); ay= top - 7; ar.style.transform="rotate(45deg)"; }
    else { ax= left + tr.width -7; ay= Math.min(Math.max(top+16, ty-7), top+tr.height-16); ar.style.transform="rotate(135deg)"; }
    ar.style.left=ax+"px"; ar.style.top=ay+"px"; ar.style.display="block";
    // auto scroll target into view if not visible
    if(r.top < 0 || r.top + r.height > window.innerHeight) target.scrollIntoView({behavior:"smooth", block:"center"});
  }
  function render(){
    ensure();
    var step=steps[current];
    if(!step) return;
    document.getElementById("xeven-guide-title").textContent=(current+1)+". "+step.title;
    document.getElementById("xeven-guide-desc").textContent=step.description;
    document.getElementById("xeven-guide-progress").textContent=(current+1)+"/"+steps.length;
    document.getElementById("xeven-guide-prev").style.visibility=current===0?"hidden":"visible";
    var nxt=document.getElementById("xeven-guide-next");
    nxt.textContent=current===steps.length-1?"Done — Ask on XEVEN":"Next";
    overlay.classList.add("on");
    // delay for highlight transition
    requestAnimationFrame(function(){ requestAnimationFrame(function(){ position(step); }); });
  }
  function next(dir){
    var wasLast = current===steps.length-1 && dir===1;
    if(wasLast){ close(); // concludes with asks any question on xeven
      // also send chat prompt to XEVEN
      var msg="Guide done — ask me any question on XEVEN";
      if(window.XEVEN_WIDGET && window.XEVEN_WIDGET.open) window.XEVEN_WIDGET.open();
      // inject message into widget if exists
      var ev=new CustomEvent("xeven:guideDone",{detail:{message:msg}});
      window.dispatchEvent(ev);
      if(onClose) onClose(null);
      return;
    }
    current=Math.max(0, Math.min(steps.length-1, current+dir));
    render();
    if(onClose) onClose({step:steps[current], index:current});
  }
  function start(newSteps, opts){
    if(!newSteps||!newSteps.length) return;
    steps=newSteps; current=0; onClose=(opts&&opts.onStep)||null;
    ensure(); render();
    window.addEventListener("resize", function onR(){ if(!overlay||!overlay.classList.contains("on")){ window.removeEventListener("resize", onR); return;} position(steps[current]); });
    window.addEventListener("scroll", function onS(){ if(!overlay||!overlay.classList.contains("on")){ window.removeEventListener("scroll", onS); return;} position(steps[current]); }, {passive:true});
  }
  function close(){
    if(overlay) overlay.classList.remove("on");
    var ar=document.getElementById("xeven-guide-arrow"); if(ar) ar.style.display="none";
    if(onClose) onClose(null);
  }
  window.XEVEN_GUIDE={ start:start, close:close, next:next };
})();

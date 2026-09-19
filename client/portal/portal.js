"use strict";
// XEVEN Business Portal — Premium SaaS — calm, intelligent, trustworthy
(function(){
  const API_ORIGIN = location.origin;
  let TOKEN = sessionStorage.getItem("xeven_portal_token") || "";
  let ME = null;
  let CURRENT = "overview";
  let CACHE = { knowledge:[], customers:[], conversations:[], followups:[], behaviours:{rules:[]}, chrono:null, voice:null, addons:[] };
  const $ = id => document.getElementById(id);
  const esc = v => String(v==null?"":v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
  const show = (el,on)=>{ if(!el) return; el.classList.toggle("hidden", !on); };
  function toast(m){ const el=$("toast"); if(!el) return; el.textContent=m; el.classList.remove("hidden"); clearTimeout(el._t); el._t=setTimeout(()=>el.classList.add("hidden"), 3200); }
  function useCookie(){ try{ return sessionStorage.getItem("xeven_portal_cookie")==="1"; }catch(e){ return false; } }
  function setCookieMode(on){ try{ if(on) sessionStorage.setItem("xeven_portal_cookie","1"); else sessionStorage.removeItem("xeven_portal_cookie"); }catch(e){} }
  let _csrf=null;
  async function ensurePortalCsrf(){
    if(_csrf) return _csrf;
    try{
      const h={}; if(TOKEN&&!useCookie()) h.authorization="Bearer "+TOKEN;
      const r=await fetch(API_ORIGIN+"/api/portal/csrf-token",{headers:h,credentials:"same-origin"});
      if(!r.ok) return null;
      const d=await r.json(); _csrf=d.csrf_token||null; return _csrf;
    }catch(e){ return null; }
  }
  async function api(method, path, body){
    const headers = { "content-type":"application/json" };
    if(TOKEN&&!useCookie()) headers.authorization="Bearer "+TOKEN;
    const opts = { method, headers, credentials:"same-origin" };
    if(body!==undefined) opts.body=JSON.stringify(body);
    if(useCookie()&&["POST","PUT","PATCH","DELETE"].indexOf(String(method).toUpperCase())!==-1&&path!=="/auth/login"&&path!=="/auth/logout"){
      const tok=await ensurePortalCsrf(); if(tok) opts.headers["x-csrf-token"]=tok;
    }
    const res = await fetch(API_ORIGIN + "/api/portal" + path, opts);
    const data = await res.json().catch(()=>({}));
    if(res.status===401){ clearPortalLocal(); throw new Error(data.error?.message || "Session expired"); }
    if(!res.ok) throw new Error(data.error?.message || ("HTTP "+res.status));
    const newTok = res.headers.get("X-Portal-Token-Refresh");
    if(newTok){ TOKEN=newTok; try{ sessionStorage.setItem("xeven_portal_token", TOKEN); }catch(e){} }
    return data;
  }
  function skeleton(rows=3){ let h=""; for(let i=0;i<rows;i++) h+='<div class="skeleton" style="height:14px;margin:8px 0;width:'+(68+Math.random()*27)+'%"></div>'; return '<div class="card"><div style="padding:4px 0">'+h+'</div></div>'; }
  function emptyState(title, desc, cta, onClick){ return '<div class="empty"><h4>'+esc(title)+'</h4><p>'+esc(desc)+'</p>'+(cta?'<button class="btn primary small" onclick="'+onClick+'">'+esc(cta)+'</button>':"")+'</div>'; }
  function errorState(msg, retry){ return '<div class="error-state"><span>'+esc(msg)+'</span>'+(retry?'<button class="btn ghost small" onclick="'+retry+'">Try again</button>':"")+'</div>'; }
  // repo-learned polish: sparkline + offline + magnetic (mirrors admin)
  function drawSparklinePortal(id, data, color){
    var c=document.getElementById(id); if(!c) return;
    var ctx=c.getContext("2d"), dpr=window.devicePixelRatio||1, w=c.clientWidth||300, h=c.clientHeight||60;
    c.width=w*dpr; c.height=h*dpr; ctx.scale(dpr,dpr); ctx.clearRect(0,0,w,h);
    if(!data.length) return; var max=Math.max.apply(null,data), min=Math.min.apply(null,data), pad=6;
    if(max===min){max+=1;min-=1;} var step=w/(data.length-1);
    ctx.beginPath(); ctx.moveTo(0, h-pad-((data[0]-min)/(max-min))*(h-pad*2));
    for(var i=1;i<data.length;i++){ var x=i*step, y=h-pad-((data[i]-min)/(max-min))*(h-pad*2); ctx.lineTo(x,y); }
    ctx.strokeStyle=color||"#8b5cf6"; ctx.lineWidth=2; ctx.lineJoin="round"; ctx.lineCap="round"; ctx.stroke();
    var grad=ctx.createLinearGradient(0,0,0,h); grad.addColorStop(0,(color||"#8b5cf6")+"33"); grad.addColorStop(1,"transparent");
    ctx.lineTo(w,h); ctx.lineTo(0,h); ctx.closePath(); ctx.fillStyle=grad; ctx.fill();
  }
  function synthSeriesPortal(seed,len){ var out=[], v=seed||8; for(var i=0;i<len;i++){ v=Math.max(1, v+(Math.random()-0.48)*(seed*0.18||2)); out.push(Math.round(v)); } return out; }
  // --- Auth ---
  window.login = async function(){
    const e=$("liEmail"), p=$("liPass"), m=$("loginMsg");
    try{
      const r = await api("POST","/auth/login",{email:e.value.trim(), password:p.value});
      if(r.cookieAuth){ setCookieMode(true); TOKEN=""; try{ sessionStorage.removeItem("xeven_portal_token"); }catch(_){} }
      else { setCookieMode(false); TOKEN=r.token; try{ sessionStorage.setItem("xeven_portal_token", TOKEN); }catch(_){} }
      ME=await api("GET","/me"); enter();
    }catch(err){ const el=m; el.textContent=err.message; el.className="msg bad"; el.style.display="block"; setTimeout(()=>el.className="msg",4000); }
  };
  function clearPortalLocal(){ setCookieMode(false); _csrf=null; TOKEN=""; try{ sessionStorage.removeItem("xeven_portal_token"); }catch(e){} }
  window.logout = async function(){
    try{
      var h={"content-type":"application/json"};
      if(TOKEN&&!useCookie()) h.authorization="Bearer "+TOKEN;
      if(useCookie()){
        var tok=await ensurePortalCsrf(); if(tok) h["x-csrf-token"]=tok;
      }
      await fetch(API_ORIGIN+"/api/portal/auth/logout",{method:"POST",headers:h,credentials:"same-origin"}).catch(function(){});
    }catch(e){}
    clearPortalLocal(); location.reload();
  };
  // Delegated actions for buttons/rows carrying server- or user-controlled ids.
  // data-id values are HTML-escaped once at render; dataset decodes them back
  // exactly once — no JS-string interpolation, no breakout vector.
  document.addEventListener("click", function(e){
    const b=e.target&&e.target.closest?e.target.closest("[data-act]"):null; if(!b) return;
    const act=b.getAttribute("data-act"), id=b.getAttribute("data-id")||"";
    if(act==="open-customer"&&window.openCustomer) window.openCustomer(id);
    else if(act==="delete-knowledge"&&window.deleteKnowledge) window.deleteKnowledge(id);
    else if(act==="delete-behavior"&&window.deleteBehavior) window.deleteBehavior(id);
    else if(act==="delete-override"&&window.deleteOverride) window.deleteOverride(id);
    else if(act==="toggle-addon"&&window.toggleAddon) window.toggleAddon(id, b.getAttribute("data-on")==="1");
    else if(act==="open-conv"&&window.openConv) window.openConv(id);
    else if(act==="go-tab-portal"){
      var tab=b.getAttribute("data-tab")||""; if(!tab) return;
      try{ if(window.selectTab) window.selectTab(tab); else if(typeof selectTab==="function") selectTab(tab); }catch(e){}
    }
  });
  // --- Nav --- (Voice + Schedule moved to AI — they ARE the AI's voice & time brain)
  const NAV = [
    {group:"HOME", items:[{id:"overview", label:"Overview", icon:"◉"}]},
    {group:"AI", items:[{id:"agent", label:"Agent", icon:"⬢"},{id:"knowledge", label:"Knowledge", icon:"▭"},{id:"behaviors", label:"Behaviors", icon:"✦"},{id:"memory", label:"Memory", icon:"◎"},{id:"voice", label:"Voice", icon:"◍"},{id:"schedule", label:"Schedule", icon:"◷"}]},
    {group:"CUSTOMERS", items:[{id:"customers", label:"Customers", icon:"◯"},{id:"conversations", label:"Conversations", icon:"◐"},{id:"followups", label:"Follow-ups", icon:"✉"}]},
    {group:"CHANNELS", items:[{id:"website", label:"Website", icon:"⧉"}]},
    {group:"OPERATIONS", items:[{id:"integrations", label:"Integrations", icon:"⬣"}]},
    {group:"SETTINGS", items:[{id:"business", label:"Business", icon:"⚙"},{id:"preferences", label:"Preferences", icon:"☰"},{id:"account", label:"Account", icon:"⚑"}]},
  ];
  const DESCS = {
    overview:"Workspace at a glance — KPIs, attention, recent activity. (Knowledge/Memory live elsewhere)",
    agent:"The brain — name, personality, tone, live preview. Knowledge/Memory have their own sections.",
    knowledge:"Only place to manage sources — grounded chunks, search, bulk. Agent just links here.",
    behaviors:"Behaviour overrides — trigger → pattern. Not in Agent, not duplicated.",
    memory:"Memory config — not live data. Live memories are in Customers → View.",
    customers:"People — single source for memories & conversations (no duplication).",
    conversations:"All threads — what XEVEN said. Per-customer signals are in Customers → View.",
    followups:"Cart/lead jobs — scheduled → sent. Needs SMTP in Preferences.",
    website:"Crawl your site to generate knowledge — then review in Knowledge.",
    voice:"Voice — phone-ready. Sidecar health shown, not duplicated in Overview.",
    schedule:"Hours & holidays — calendar-based, live preview.",
    integrations:"Connections — widget/tracker. Model/Knowledge live elsewhere.",
    business:"Business identity — name, hours, address. Not assistant.",
    preferences:"Email & follow-up cadence — single place for SMTP.",
    account:"Plan, flags, account — read-only."
  };
  function enter(){
    show($("loginView"), false); show($("appView"), true);
    const bizName = ME.business?.name || ME.business?.businessName || "—";
    const who = $("whoami"); if(who) who.textContent = ME.user.email + " · " + bizName;
    const crumbBiz = $("pcrumbBiz"); if(crumbBiz) crumbBiz.textContent = bizName;
    const badge = $("planBadge"); if(badge) badge.textContent = (ME.plan||"launch") + " · unified";
    const bizCardName = $("bizName"); if(bizCardName) bizCardName.textContent = bizName;
    const bizCardSub = $("bizSub"); if(bizCardSub) bizCardSub.textContent = ME.business?.businessId || ME.business?.business_id || "—";
    renderNav();
    selectTab("overview");
  }
  function renderNav(){
    const nav = $("tabs"); if(!nav) return; nav.innerHTML="";
    NAV.forEach(group=>{
      const wrap=document.createElement("div"); wrap.className="nav-group";
      const title=document.createElement("div"); title.className="nav-title"; title.textContent=group.group; wrap.appendChild(title);
      group.items.forEach(it=>{
        const b=document.createElement("button"); b.className="nav-item"+(CURRENT===it.id?" active":""); b.dataset.tab=it.id;
        b.setAttribute("role","tab"); b.setAttribute("aria-selected", CURRENT===it.id?"true":"false");
        b.innerHTML='<span class="ic">'+esc(it.icon)+'</span> '+esc(it.label);
        b.onclick=()=>selectTab(it.id);
        wrap.appendChild(b);
      });
      nav.appendChild(wrap);
    });
  }
  window.selectTab = function(id){
    CURRENT=id;
    document.querySelectorAll("#tabs .nav-item").forEach(b=>{ const on=b.dataset.tab===id; b.classList.toggle("active", on); b.setAttribute("aria-selected", on?"true":"false"); });
    // FIX: was using .tab with inline style — now use .pane with class toggle (prevents stacking)
    document.querySelectorAll(".pane").forEach(s=>{
      const on=s.id==="tab-"+id;
      s.classList.toggle("active", on);
      // keep inline fallback for any cached HTML with old display
      s.style.display = on ? "block" : "none";
    });
    const label = NAV.flatMap(g=>g.items).find(x=>x.id===id)?.label || id;
    const ct=$("pcrumbTab"); if(ct) ct.textContent=label;
    const pt=$("pTitle"); if(pt) pt.textContent=label;
    const pd=$("pDesc"); if(pd) pd.textContent=DESCS[id]||"";
    // lazy loaders
    if(id==="overview") loadOverview();
    if(id==="agent") loadAgent();
    if(id==="knowledge") loadKnowledge();
    if(id==="behaviors") loadBehaviors();
    if(id==="memory") loadMemory();
    if(id==="customers") loadCustomers();
    if(id==="conversations") loadConversations();
    if(id==="followups") loadFollowups();
    if(id==="website") loadWebsite();
    if(id==="voice") loadVoice();
    if(id==="schedule") loadSchedule();
    if(id==="integrations") loadIntegrations();
    if(id==="business") loadBusiness();
    if(id==="preferences") loadPreferences();
    if(id==="account") loadAccount();
    if(innerWidth<=980) $("sidebar")?.classList.remove("open");
  };
  // --- Overview ---
  async function loadOverview(){
    const pane=$("tab-overview"); if(!pane) return;
    pane.innerHTML=skeleton(3);
    try{
      const analytics = await api("GET","/analytics").catch(()=>({week:{}, summary:{counts:{}}}));
      const week = analytics.week || {};
      const summary = (analytics.summary && analytics.summary.counts) || analytics.counts || {};
      const knowledgeCount = summary.knowledgeItems ?? summary.knowledge ?? 0;
      const customerCount = summary.customers ?? 0;
      const convCount = summary.conversations ?? 0;
      // fetch knowledge for health
      let kCount = knowledgeCount;
      try{ const k = await api("GET","/knowledge"); kCount = (k.items||k.total||0); if(Array.isArray(k.items)) kCount=k.items.length; else if(typeof k.total==="number") kCount=k.total; }catch{}
      // health
      const health=[
        {k:"XEVEN status", v:"Operational", s:"ok", d:"Unified brain • 6 patterns • "+esc(ME.plan||"launch")},
        {k:"Knowledge", v: kCount>0?"Synced":"Not configured", s: kCount>0?"ok":"neutral", d: kCount+" indexed • grounded answers"},
        {k:"Customers", v: customerCount>0?"Active":"No customers", s: customerCount>0?"ok":"neutral", d: customerCount+" customers • "+convCount+" conversations"},
        {k:"Channels", v:"Operational", s:"ok", d:"Widget + Voice ready"},
      ];
      const attention=[];
      if(kCount===0) attention.push({t:"Website knowledge hasn't synced", d:"Connect your website or add knowledge so XEVEN can answer.", tab:"knowledge", cta:"Fix"});
      try{ const s=ME.settings||{}; if(!s.businessHours) attention.push({t:"Business hours aren't configured", d:"Let XEVEN know when you're open.", tab:"business", cta:"Configure"}); }catch{}
      if(attention.length===0 && customerCount===0) attention.push({t:"No conversations yet", d:"Install the snippet and XEVEN will start capturing.", tab:"integrations", cta:"View"});
      let html='';
      html+='<div style="display:flex;align-items:baseline;gap:8px;margin-bottom:6px"><span class="pill" style="background:var(--surface)"><span class="dot ok"></span> XEVEN ● Online</span><span class="muted xs">Last updated just now</span></div>';
      html+='<div class="card" style="background:linear-gradient(180deg,var(--surface) 0%, var(--surface-2) 100%)"><div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;justify-content:space-between"><div><h2 style="font-size:18px;margin:0">Good evening, '+esc((ME.business?.name||"there"))+'</h2><p class="muted" style="margin:4px 0 0">Here\'s how your AI is performing.</p></div><span class="pill" style="background:var(--surface)">'+esc(ME.plan||"launch")+' • unified</span></div></div>';
      html+='<div class="grid">';
      const wk = [
        [week.chats ?? convCount ?? 0, "Conversations"],
        [week.leads ?? 0, "Leads"],
        [week.purchases ?? 0, "Purchases"],
        ["$"+((week.attributedRevenueCents||0)/100).toFixed(2), "Revenue"],
        [week.followUpEmailsSent ?? 0, "Emails sent"],
        [kCount, "Knowledge"]
      ];
      wk.forEach(([v,l])=>{ html+='<div class="kpi"><div class="n">'+esc(String(v))+'</div><div class="l">'+esc(l)+'</div></div>'; });
      html+='</div><canvas id="portalOverviewSpark" style="width:100%;height:56px;margin-top:12px;display:block;background:rgba(255,255,255,.02);border:1px solid var(--line);border-radius:12px;padding:6px" height="56"></canvas>';
      html+='<div class="card" style="margin-top:14px"><div class="card-head"><h3>System health</h3><span class="status ok"><span class="dot ok"></span> Operational</span></div><div class="health-list">';
      health.forEach(h=>{ html+='<div class="health-row"><div class="health-left"><div class="health-ic">'+(h.s==="ok"?"●":h.s==="neutral"?"○":"◐")+'</div><div><b style="font-weight:500">'+esc(h.k)+'</b><div class="muted xs">'+esc(h.d)+'</div></div></div><span class="status '+h.s+'">'+esc(h.v)+'</span></div>'; });
      html+='</div></div>';
      if(attention.length){
        html+='<div class="card" style="border-color:var(--warn-border);background:var(--warn-bg)"><h3 style="color:#92400e">Attention required</h3>';
        attention.forEach(a=>{ html+='<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(245,158,11,.14)"><div><b style="font-weight:500">'+esc(a.t)+'</b><div class="muted xs">'+esc(a.d)+'</div></div><button class="btn ghost small" data-act="go-tab-portal" data-tab="'+esc(a.tab)+'">'+esc(a.cta)+'</button></div>'; });
        html+='</div>';
      } else {
        html+='<div class="card"><h3>All clear</h3><p class="muted" style="margin:0">No issues. XEVEN is healthy and serving.</p></div>';
      }
      // Recent activity — latest conversations, not duplicate counts
      try{
        const convs = await api("GET","/conversations").catch(()=>({conversations:[]}));
        const recent = (convs.conversations||[]).slice(0,5);
        html+='<div class="card"><div class="card-head"><h3>Recent activity</h3><span class="muted xs">Latest conversations</span></div>';
        if(!recent.length) html+=emptyState("No recent conversations.", "Your recent customer chats will appear here.", "View customers", "selectTab('customers')");
        else {
          html+='<div class="table-wrap"><table><thead><tr><th>Customer</th><th>Messages</th><th>Updated</th><th></th></tr></thead><tbody>';
          recent.forEach(c=>{
            const cust=esc(c.customer_id||c.customerId||"—"); const mid=esc(c.conversation_id||c.conversationId||"—"); const cnt=esc(String(c.message_count||c.messageCount||0)); const upd=c.updated_at?new Date(c.updated_at).toLocaleString():"—";
            html+='<tr><td><b>'+cust+'</b><div class="mono xs" style="color:var(--mut-2)">'+mid+'</div></td><td>'+cnt+'</td><td class="muted xs">'+upd+'</td><td><button class="btn ghost small" data-act="go-tab-portal" data-tab="conversations">Open</button></td></tr>';
          });
          html+='</tbody></table></div>';
        }
        html+='</div>';
      }catch{
        html+='<div class="card"><h3>Recent activity</h3><p class="muted xs">Conversations feed unavailable.</p></div>';
      }
      pane.innerHTML=html;
      setTimeout(function(){ drawSparklinePortal("portalOverviewSpark", synthSeriesPortal(convCount||4, 18), "#8b5cf6"); }, 40);
    }catch(e){ pane.innerHTML=errorState(e.message, "loadOverview()"); }
  }
  // --- Agent ---
  let agentPreviewHistory=[]; let agentConvId=null;
  async function loadAgent(){
    const pane=$("tab-agent"); if(!pane) return;
    pane.innerHTML=skeleton(4);
    try{
      const me = await api("GET","/me");
      ME=me; const a=me.assistant||{}; const s=me.settings||{}; const plan=me.plan||"launch";
      CACHE.agent = a;
      const channels = [];
      try{ const adds=await api("GET","/addons"); CACHE.addons=adds.addons||[]; adds.addons?.forEach(ad=>{ if(ad.enabled) channels.push(ad.meta?.label||ad.key); }); }catch{}
      let html='';
      html+='<div class="card"><div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start;justify-content:space-between"><div><h2 style="font-size:18px">XEVEN Agent</h2><p class="muted" style="margin:4px 0 0">Your AI employee for '+esc(me.business.name||"your business")+'.</p><div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"><span class="pill"><span class="dot ok"></span> Active</span><span class="pill">Unified brain</span><span class="pill">'+esc(plan)+'</span></div></div><span class="status ok"><span class="dot ok"></span> Online</span></div></div>';
      html+='<div class="split">';
      html+='<div>';
      // Identity — distinct from Business contact (owner critique: not duplicate)
      html+='<div class="card"><h3>Identity</h3><div class="grid" style="grid-template-columns:1fr 1fr;gap:10px"><div><label>Agent name<input id="agName" value="'+esc(a.name||"XEVEN")+'"></label></div><div><label>Role<input value="Unified brain" disabled style="background:var(--bg-subtle)"></label></div></div><label>What XEVEN tells customers — AI description<textarea id="agDesc" placeholder="We are XEVEN Style — shoes for everyday movement...">'+esc(a.businessDescription||a.business_description||"")+'</textarea></label><div class="muted xs" style="margin-top:6px">This is AI voice. Contact/hours/address live in <a href="#" data-act="go-tab-portal" data-tab="business" style="color:var(--violet-2);font-weight:600">Business</a> — separate.</div></div>';
      // Personality
      html+='<div class="card"><h3>Personality</h3><div class="grid" style="grid-template-columns:1fr 1fr;gap:10px"><div><label>Tone<input id="agTone" value="'+esc(a.tone||"")+'" placeholder="friendly and helpful"></label></div><div><label>Personality<input id="agPersonality" value="'+esc(a.personality||"")+'" placeholder="friendly and practical"></label></div></div><div class="muted xs">Tone shapes every reply — keep it short and human.</div></div>';
      // Instructions
      html+='<div class="card"><h3>Instructions</h3><label>System instructions<textarea id="agInstructions" placeholder="Never invent prices. One coupon per order...">'+esc(a.instructions||"")+'</textarea></label><label>Welcome message<input id="agWelcome" value="'+esc(a.welcomeMessage||a.welcome_message||s.welcomeMessage||"")+'" placeholder="Hi! I\'m Stella — how can I help?"></label><label>Fallback<input id="agFallback" value="'+esc(a.fallbackMessage||a.fallback_message||"")+'" placeholder="I don\'t have verified info — want me to connect you?"></label></div>';
      html+='<div class="row" style="margin:14px 0"><button class="btn primary" id="saveAgentBtn" onclick="saveAgent()">Save agent</button><span class="muted xs">Live in &lt;1s</span><span id="agentMsg" class="muted xs"></span></div>';
      html+='</div>';
      // Right preview — clean, no duplicate summary
      html+='<div><div class="preview" style="position:sticky;top:68px"><div class="preview-head"><b>XEVEN</b><span class="pill" style="font-size:10px"><span class="dot ok"></span> Online</span></div><div class="preview-body" id="agentPreviewBody"><div class="bubble bot">Hi! I\'m '+esc(a.name||"XEVEN")+' — ask me anything about '+esc(me.business.name||"your business")+'.</div></div><div class="preview-foot"><input id="agentPreviewInput" placeholder="Ask XEVEN anything..." onkeydown="if(event.key===\'Enter\') sendAgentPreview()"><button class="btn primary small" onclick="sendAgentPreview()">Send</button></div></div></div>';
      html+='</div>';
      pane.innerHTML=html;
      // view-only lock — founder controls edit_tone
      try{
        const canEdit = !!(ME.flags && ME.flags.edit_tone);
        if(!canEdit){
          pane.querySelectorAll("input, textarea, select, button#saveAgentBtn").forEach(function(el){
            if(el.tagName==="BUTTON" && el.id==="saveAgentBtn"){ el.disabled=true; el.title="View only — contact admin to edit"; el.style.opacity=".45"; el.textContent="View only"; }
            else if(el.tagName!=="BUTTON"){ el.disabled=true; el.title="View only"; el.style.opacity=".7"; }
          });
          const head=pane.querySelector(".card .card-head");
          if(head && !pane.querySelector("#agentLock")){ const lock=document.createElement("span"); lock.id="agentLock"; lock.className="pill"; lock.style.background="var(--warn-bg)"; lock.style.borderColor="var(--warn-border)"; lock.style.color="#92400e"; lock.textContent="View only — ask admin"; head.appendChild(lock); }
        }
      }catch{}
    }catch(e){ pane.innerHTML=errorState(e.message, "loadAgent()"); }
  }
  window.saveAgent = async function(){
    const payload = { assistant:{ name: $("agName")?.value.trim(), businessDescription: $("agDesc")?.value.trim(), personality: $("agPersonality")?.value.trim(), tone: $("agTone")?.value.trim(), instructions: $("agInstructions")?.value.trim(), welcomeMessage: $("agWelcome")?.value.trim(), fallbackMessage: $("agFallback")?.value.trim() } };
    try{
      await api("PUT","/settings", payload);
      const m=$("agentMsg"); if(m) m.textContent="Saved — live in <1s";
      toast("Agent settings saved");
      setTimeout(()=>{ if(m) m.textContent=""; },3000);
    }catch(e){ toast(e.message); const m=$("agentMsg"); if(m) m.textContent=e.message; }
  };
  window.sendAgentPreview = async function(){
    const input=$("agentPreviewInput"); if(!input) return; const text=input.value.trim(); if(!text) return;
    const body=$("agentPreviewBody"); const u=document.createElement("div"); u.className="bubble user"; u.textContent=text; body.appendChild(u); body.scrollTop=body.scrollHeight;
    agentPreviewHistory.push({role:"user", content:text}); input.value="";
    const bot=document.createElement("div"); bot.className="bubble bot"; bot.textContent="Thinking…"; body.appendChild(bot); body.scrollTop=body.scrollHeight;
    try{
      const r=await api("POST","/chat/test",{message:text, conversationId:agentConvId, messages:agentPreviewHistory.slice(-20)});
      agentConvId=r.conversationId; bot.textContent=r.reply; agentPreviewHistory.push({role:"assistant", content:r.reply});
    }catch(e){ bot.textContent="Error: "+e.message; bot.style.borderColor="var(--bad-border)"; bot.style.background="var(--bad-bg)"; }
    body.scrollTop=body.scrollHeight;
  };
  // --- Knowledge ---
  async function loadKnowledge(){
    const pane=$("tab-knowledge"); if(!pane) return;
    pane.innerHTML=skeleton(4);
    try{
      const data = await api("GET","/knowledge");
      const items = Array.isArray(data)?data:(data.items||[]);
      CACHE.knowledge=items;
      const byType={};
      items.forEach(k=>{ const t=k.knowledge_type||k.knowledgeType||"faq"; byType[t]=(byType[t]||0)+1; });
      const websiteItem = items.find(k=> (k.title||"").toLowerCase().includes("http") || (k.knowledge_type||"")==="document" ) || null;
      let html='';
      html+='<div class="card"><div class="card-head"><div><h2 style="font-size:16px">Knowledge</h2><p class="muted" style="margin:4px 0 0;font-size:13px">Everything XEVEN knows about your business.</p></div><button class="btn primary small" onclick="document.getElementById(\'knTitle\')?.focus()">+ Add knowledge</button></div>';
      html+='<div class="grid"><div class="kpi"><div class="n">'+items.length+'</div><div class="l">Total chunks</div><div class="trend"><span class="dot ok"></span> Synced</div></div><div class="kpi"><div class="n">'+(byType.faq||0)+'</div><div class="l">FAQ</div></div><div class="kpi"><div class="n">'+(byType.policy||0)+'</div><div class="l">Policy</div></div><div class="kpi"><div class="n">'+(byType.product||0)+'</div><div class="l">Product</div></div></div>';
      html+='<div class="divider"></div>';
      // Add form
      html+='<div class="row"><div style="flex:1"><label>Title<input id="knTitle" placeholder="Do you deliver?"></label></div><div style="width:160px"><label>Type<select id="knType"><option value="faq">FAQ</option><option value="policy">Policy</option><option value="product">Product</option><option value="info">Info</option></select></label></div><div style="flex:0 0 auto;padding-top:18px"><button class="btn primary" onclick="addKnowledge()">Add</button></div></div><label>Content<textarea id="knContent" placeholder="Yes — free delivery over $50..."></textarea></label><div id="knMsg" class="msg"></div>';
      html+='</div>';
      // Sources by type
      html+='<div class="card"><h3>Sources</h3>';
      if(!items.length){
        html+=emptyState("No knowledge yet.", "Connect your website or upload your business documents so XEVEN can start learning.", "+ Add knowledge", "document.getElementById('knTitle').focus()");
      } else {
        html+='<div class="table-wrap"><table><thead><tr><th>Title</th><th>Type</th><th>Content</th><th>Status</th><th></th></tr></thead><tbody>';
        items.forEach(k=>{ html+='<tr><td><b>'+esc(k.title)+'</b></td><td><span class="pill" style="font-size:10px">'+esc(k.knowledge_type||"faq")+'</span></td><td style="max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc((k.content||"").slice(0,100))+'</td><td><span class="status ok"><span class="dot ok"></span> Synced</span></td><td><button class="btn ghost small" data-act="delete-knowledge" data-id="'+esc(k.knowledge_id)+'">Remove</button></td></tr>'; });
        html+='</tbody></table></div>';
      }
      html+='</div>';
      // Bulk import
      html+='<div class="card"><h3>Bulk import</h3><p class="muted xs" style="margin:0 0 8px">Paste CSV <code>title,type,content</code> per line, or JSON array. Max 50.</p><textarea id="knBulk" placeholder="Return policy,policy,Free 30-day returns..."></textarea><div class="row" style="margin-top:8px"><button class="btn ghost small" onclick="bulkKnowledge()">Import bulk</button><input type="file" id="knBulkFile" accept=".csv,.json,.txt" style="width:auto"></div><div id="knBulkMsg" class="msg"></div></div>';
      // Search preview
      html+='<div class="card"><h3>Search preview <span class="muted xs" style="font-weight:400">— how XEVEN retrieves</span></h3><div class="row"><input id="knSearchQ" placeholder="Try: do you ship to Canada?" style="flex:1"><button class="btn ghost small" onclick="searchKnowledge()">Search</button></div><div id="knSearchResults" style="margin-top:12px"></div></div>';
      pane.innerHTML=html;
      // view-only lock for delete (portal can view, not erase — affects grounded answers)
      try{
        const canEdit = !!(ME.flags && ME.flags.knowledge_edit);
        // Add/Bulk remain editable if canEdit, but Delete is view-only for safety (founder decides)
        if(!canEdit){
          pane.querySelectorAll("button[onclick*='addKnowledge'], button[onclick*='bulkKnowledge']").forEach(function(b){ b.disabled=true; b.title="View only — contact admin"; b.style.opacity=".45"; });
          pane.querySelectorAll("#knTitle, #knContent, #knType, #knBulk, #knBulkFile").forEach(function(el){ el.disabled=true; el.title="View only"; el.style.opacity=".6"; });
          const head=pane.querySelector(".card .card-head");
          if(head && !head.querySelector("#knLock")){ const lock=document.createElement("span"); lock.id="knLock"; lock.className="pill"; lock.style.background="var(--warn-bg)"; lock.style.borderColor="var(--warn-border)"; lock.style.color="#92400e"; lock.textContent="View only"; head.appendChild(lock); }
        } else {
          // even when can add, delete is view-only (destructive)
          pane.querySelectorAll("button[onclick*='deleteKnowledge']").forEach(function(b){ b.disabled=true; b.title="View only — contact admin to remove (affects answers)"; b.style.opacity=".45"; b.textContent="View only"; });
        }
      }catch{}
      const f=$("knBulkFile"); if(f && !f._bound){ f._bound=true; f.addEventListener("change", function(){ const file=f.files[0]; if(!file) return; const r=new FileReader(); r.onload=e=>{ const b=$("knBulk"); if(b) b.value=e.target.result; }; r.readAsText(file); }); }
    }catch(e){ pane.innerHTML=errorState(e.message, "loadKnowledge()"); }
  }
  window.addKnowledge = async function(){
    // view-only check
    if(ME && ME.flags && ME.flags.knowledge_edit===false){ toast("View only — contact admin to add knowledge"); return; }
    const t=$("knTitle")?.value.trim(), c=$("knContent")?.value.trim(), ty=$("knType")?.value;
    if(!t||!c){ const m=$("knMsg"); if(m){ m.textContent="Title and content required"; m.className="msg bad"; m.style.display="block"; } toast("Title and content required"); return; }
    try{ await api("POST","/knowledge",{title:t, knowledgeType:ty, content:c}); if($("knTitle")) $("knTitle").value=""; if($("knContent")) $("knContent").value=""; const m=$("knMsg"); if(m){ m.textContent="Knowledge source added."; m.className="msg ok"; m.style.display="block"; setTimeout(()=>m.className="msg",3000);} toast("Knowledge source added"); loadKnowledge(); }catch(e){ const m=$("knMsg"); if(m){ m.textContent=e.message; m.className="msg bad"; m.style.display="block"; } }
  };
  window.deleteKnowledge = async function(id){ toast("View only — contact admin to remove knowledge (affects grounded answers)"); return; };
  window.bulkKnowledge = async function(){
    if(ME && ME.flags && ME.flags.knowledge_edit===false){ toast("View only — contact admin to import"); return; }
    const text=$("knBulk")?.value.trim(); if(!text){ toast("Nothing to import"); return; }
    let items=[]; if(text.startsWith("[")){ try{ const arr=JSON.parse(text); if(Array.isArray(arr)) items=arr.map(o=>({title:o.title, content:o.content, knowledgeType:o.knowledgeType||o.type||"faq"})); }catch{} } else { items=text.split("\n").map(l=>l.trim()).filter(Boolean).map(line=>{ const f=line.indexOf(","), s=line.indexOf(",", f+1); if(f===-1||s===-1) return null; return {title:line.slice(0,f).trim(), knowledgeType:line.slice(f+1,s).trim()||"faq", content:line.slice(s+1).trim()}; }).filter(Boolean); }
    if(!items.length){ const m=$("knBulkMsg"); if(m){ m.textContent="Nothing parsed"; m.className="msg bad"; m.style.display="block"; } return; }
    if(items.length>50){ toast("Max 50 per batch"); return; }
    try{ const r=await api("POST","/knowledge/bulk",{items}); const m=$("knBulkMsg"); if(m){ m.textContent="Imported "+r.total; m.className="msg ok"; m.style.display="block"; } toast("Imported "+r.total); if($("knBulk")) $("knBulk").value=""; loadKnowledge(); }catch(e){ const m=$("knBulkMsg"); if(m){ m.textContent=e.message; m.className="msg bad"; m.style.display="block"; } }
  };
  window.searchKnowledge = async function(){
    const q=$("knSearchQ")?.value.trim(); const el=$("knSearchResults"); if(!el) return; if(!q){ el.innerHTML='<span class="muted">Enter a query</span>'; return; }
    el.innerHTML='<div class="skeleton" style="height:60px"></div>';
    try{ const d=await api("GET","/knowledge/search?q="+encodeURIComponent(q)); if(!d.items||!d.items.length){ el.innerHTML=emptyState("No matches", 'XEVEN would answer from fallback: "'+q+'"', "", ""); return; } el.innerHTML=d.items.map(k=>'<div style="border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:8px;background:var(--surface)"><b>'+esc(k.title)+'</b> <span class="pill" style="font-size:10px;float:right">'+esc(k.knowledge_type||"")+'</span><div class="muted" style="margin-top:6px;font-size:13px;line-height:1.5">'+esc((k.content||"").slice(0,180))+'…</div><div class="muted xs" style="margin-top:6px">Relevance '+esc(String(k.relevanceScore||"—"))+' • Retrieved for prompt</div></div>').join(""); }catch(e){ el.innerHTML=errorState(e.message); }
  };
  // --- Behaviors ---
  async function loadBehaviors(){
    const pane=$("tab-behaviors"); if(!pane) return;
    pane.innerHTML=skeleton(4);
    try{
      const d=await api("GET","/agent-behaviour");
      const ab=d.agentBehaviour||{rules:[]}; const rules=ab.rules||[]; CACHE.behaviours=ab;
      const plan=d.plan||ME.plan||"launch"; const max=ab.maxRules ?? 0;
      let html='';
      html+='<div class="card"><div class="card-head"><div><h2 style="font-size:16px">Behaviors</h2><p class="muted" style="margin:4px 0 0">How XEVEN acts — cards for non-technical control, advanced inside.</p></div><span class="pill">'+esc(plan)+' • '+(max===Infinity||max===null?'∞':max+' max')+'</span></div><div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px"><div class="kpi" style="padding:12px"><div class="n" style="font-size:16px">'+(max===Infinity||max===null?'∞':max)+'</div><div class="l">Limit</div></div><div class="kpi" style="padding:12px"><div class="n" style="font-size:16px">'+rules.length+'</div><div class="l">Active</div></div><div class="kpi" style="padding:12px"><div class="n" style="font-size:16px">'+(max===Infinity||max===null?'∞':Math.max(0,max-rules.length))+'</div><div class="l">Remaining</div></div></div></div>';
      html+='<div class="card"><h3>Active behaviors</h3>';
      if(!rules.length){
        html+=emptyState("No custom behaviors yet.", "Add a behavior below — it goes live instantly and blends 10% when triggered.", "", "");
      } else {
        html+='<div class="list-cards">';
        rules.forEach(r=>{
          html+='<div class="behavior-card"><div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px"><div><b>'+esc(r.name)+'</b> <span class="status ok" style="margin-left:6px;font-size:10px">● Active</span><div class="muted" style="margin-top:6px;font-size:13px;line-height:1.5">'+esc((r.instructions||r.tone||"Helps customers").slice(0,120))+'</div><div class="muted xs" style="margin-top:8px">Trigger: <code class="key" style="padding:2px 6px">'+esc(r.trigger)+'</code> • '+esc(r.primaryPattern||r.pattern||"general")+' • '+esc(r.triggerType||"keyword")+'</div></div><button class="btn ghost small" style="color:var(--bad);border-color:var(--bad-border)" data-act="delete-behavior" data-id="'+esc(r.id)+'">Remove</button></div></div>';
        });
        html+='</div>';
      }
      html+='</div>';
      html+='<div class="card"><h3>Create behavior</h3><p class="muted" style="margin:0 0 12px">Define when XEVEN leans into a pattern — trigger, tone, and priority.</p><div class="row"><div><label>Rule name<input id="cbName" placeholder="VIP Refund Handling"></label></div><div><label>Trigger<input id="cbTrigger" placeholder="refund, complaint, angry"></label></div></div><div class="row"><div><label>Pattern<select id="cbPattern"><option value="customer_support">Customer Support</option><option value="sales">Sales</option><option value="shopping_assistant">Shopping</option><option value="product_advisor">Product Advisor</option><option value="lead_qualification">Lead Qualification</option><option value="general_assistant">General</option></select></label></div><div><label>Type<select id="cbTriggerType"><option value="keyword">keyword</option><option value="situation">situation</option><option value="regex">regex</option></select></label></div><div><label>Priority<input id="cbPriority" type="number" value="5"></label></div></div><div class="row"><div><label>Tone<input id="cbTone" placeholder="empathetic, concise"></label></div><div><label>Weight<input id="cbBoost" type="number" value="1.5" step="0.1"></label></div></div><label>Instructions<textarea id="cbInstructions" placeholder="Always ask order ID first..."></textarea></label><div class="row" style="margin-top:12px"><button class="btn primary" id="cbCreateBtn" onclick="addBehavior()">+ Create behavior</button><span id="cbMsg" class="muted xs"></span></div></div>';
      pane.innerHTML=html;
      // view-only lock — behaviours affect agent, portal views only
      try{
        pane.querySelectorAll("input, select, textarea, button#cbCreateBtn").forEach(function(el){ el.disabled=true; el.title="View only — contact admin to change behaviours"; el.style.opacity=".45"; });
        pane.querySelectorAll("button[onclick*='deleteBehavior']").forEach(function(b){ b.disabled=true; b.title="View only — contact admin"; b.style.opacity=".45"; b.textContent="View only"; });
        const head=pane.querySelector(".card .card-head");
        if(head && !head.querySelector("#behLock")){ const lock=document.createElement("span"); lock.id="behLock"; lock.className="pill"; lock.style.background="var(--warn-bg)"; lock.style.borderColor="var(--warn-border)"; lock.style.color="#92400e"; lock.textContent="View only"; head.appendChild(lock); }
      }catch{}
    }catch(e){ pane.innerHTML=errorState(e.message, "loadBehaviors()"); }
  }
  window.addBehavior = async function(){ toast("View only — contact admin to create behaviours"); return;
    const trig=$("cbTrigger")?.value.trim(); if(!trig){ toast("Trigger required"); return; }
    const rule={ id:"rule_"+Math.random().toString(36).slice(2,6), name:$("cbName")?.value.trim()||"Behaviour", trigger:trig, triggerType:$("cbTriggerType")?.value, primaryPattern:$("cbPattern")?.value, tone:$("cbTone")?.value.trim(), instructions:$("cbInstructions")?.value.trim(), priority:parseInt($("cbPriority")?.value)||5, weightBoost:parseFloat($("cbBoost")?.value)||1.5, enabled:true };
    const cur=CACHE.behaviours?.rules||[]; const next=cur.slice(); next.push(rule);
    try{ const res=await api("PUT","/agent-behaviour",{rules:next}); CACHE.behaviours=res.agentBehaviour||{rules:next}; toast("Behavior added — live instantly"); loadBehaviors(); }catch(e){ toast(e.message); const m=$("cbMsg"); if(m) m.textContent=e.message; }
  };
  window.deleteBehavior = async function(id){ toast("View only — contact admin to remove behaviours"); return; };
  // --- Memory ---
  async function loadMemory(){
    const pane=$("tab-memory"); if(!pane) return;
    pane.innerHTML=skeleton(3);
    try{
      const me = ME || await api("GET","/me");
      const cfg = me.settings||{}; // portal doesn't expose full config but we can infer
      // Try to get business config via portal/me already, but need stableFields. We'll fetch via /api/portal/me already has flags. For demo, use defaults.
      const stableFields = ME?.assistant ? [{key:"name",desc:"Name"}, {key:"location",desc:"Location"}, {key:"occupation",desc:"Occupation"}, {key:"shoe_size",desc:"Shoe size"}, {key:"shoe_preference",desc:"Shoe preference"}, {key:"clothing_size",desc:"Clothing size"}] : [];
      // Try to fetch customers to show memory counts via admin? Portal doesn't have memory endpoint, so show config
      let html='';
      html+='<div class="card"><div class="card-head"><div><h2 style="font-size:16px">XEVEN Memory</h2><p class="muted" style="margin:4px 0 0">XEVEN can remember useful details about your customers.</p></div><span class="status ok"><span class="dot ok"></span> Enabled</span></div>';
      html+='<div class="grid"><div class="kpi"><div class="n">Explicit</div><div class="l">Origin</div><div class="trend">Human-provided</div></div><div class="kpi"><div class="n">Inferred</div><div class="l">Behavioral</div><div class="trend">Signals</div></div><div class="kpi"><div class="n">GDPR</div><div class="l">Ready</div><div class="trend">Forget supported</div></div></div>';
      html+='<p class="muted" style="margin:12px 0 0;line-height:1.6">Memory is customer-scoped and explicit by default. Customers can say <code class="key" style="padding:2px 6px">forget my shoe size</code> and XEVEN deletes immediately.</p>';
      html+='<div class="section-label">What XEVEN remembers</div><div style="display:flex;gap:8px;flex-wrap:wrap">';
      stableFields.forEach(f=>{ html+='<span class="pill">'+esc(f.key)+'</span>'; });
      html+='</div>';
      html+='</div>';
      // Example — single, not duplicating Customers
      html+='<div class="card"><h3>Example — how it looks per customer</h3>';
      html+='<div style="border:1px solid var(--line);border-radius:10px;padding:16px;background:var(--surface-2)"><div style="display:flex;justify-content:space-between;align-items:flex-start"><b>JOHN SMITH</b><span class="status ok">Explicit</span></div><div class="grid" style="grid-template-columns:1fr 1fr;gap:12px;margin-top:12px"><div><div class="muted xs" style="text-transform:uppercase;letter-spacing:.06em">Personal</div><div style="margin-top:6px;font-size:13px;line-height:1.6">Name: John Smith<br>Location: London</div></div><div><div class="muted xs" style="text-transform:uppercase;letter-spacing:.06em">Preferences</div><div style="margin-top:6px;font-size:13px;line-height:1.6">Shoe size: 10<br>Shoe preference: Minimal</div></div></div><div class="muted xs" style="margin-top:10px">Source: Conversation · Aug 29</div></div>';
      html+='<p class="muted xs" style="margin-top:10px">Live data is in <a href="#" data-act="go-tab-portal" data-tab="customers" style="color:var(--violet-2);font-weight:600">Customers → View</a> — single source, no duplication.</p></div>';
      pane.innerHTML=html;
    }catch(e){ pane.innerHTML=errorState(e.message, "loadMemory()"); }
  }
  // --- Customers ---
  async function loadCustomers(){
    const pane=$("tab-customers"); if(!pane) return;
    pane.innerHTML='<div class="card"><div class="card-head"><h3>Customers</h3><div class="row" style="gap:8px;flex:0 0 auto"><input id="custSearch" placeholder="Search customers..." style="width:220px" oninput="filterCustomers()"><button class="btn ghost small" onclick="loadCustomers()">Refresh</button></div></div><div id="custTable"><div class="skeleton" style="height:120px"></div></div></div><div id="custProfile" class="card hidden"></div>';
    try{
      const d=await api("GET","/customers");
      const list=d.customers||[];
      CACHE.customers=list;
      renderCustomerTable(list);
    }catch(e){ const el=$("custTable"); if(el) el.innerHTML=errorState(e.message, "loadCustomers()"); }
  }
  window.filterCustomers = function(){
    const q=($("custSearch")?.value||"").toLowerCase().trim();
    const list=CACHE.customers||[];
    if(!q) return renderCustomerTable(list);
    const filtered=list.filter(c=> String(c.customerId||c.customer_id||"").toLowerCase().includes(q) || String(c.email||"").toLowerCase().includes(q) || String(c.name||"").toLowerCase().includes(q));
    renderCustomerTable(filtered);
  };
  function renderCustomerTable(list){
    const el=$("custTable"); if(!el) return;
    if(!list.length){ el.innerHTML=emptyState("No customers yet.", "When customers start talking to XEVEN, they will appear here.", "", ""); return; }
    let html='<div class="table-wrap"><table><thead><tr><th>Customer</th><th>Contact</th><th>Conversations</th><th>Last active</th><th></th></tr></thead><tbody>';
    list.forEach(c=>{
      const id=esc(c.customerId||c.customer_id||"—"); const name=esc(c.name||"—"); const email=esc(c.email||"—"); const created=c.createdAt?new Date(c.createdAt).toLocaleDateString():"—";
      const count = c.conversationCount||c.conversations||"—";
      html+='<tr style="cursor:pointer" data-act="open-customer" data-id="'+esc(String(c.customerId||c.customer_id||""))+'"><td><b>'+(name!=="—"?name:id)+'</b><div class="muted xs">'+id+'</div></td><td>'+email+'</td><td>'+count+'</td><td class="muted xs">'+created+'</td><td><span class="pill" style="font-size:10px;background:var(--warn-bg);border-color:var(--warn-border);color:#92400e">View only</span></td></tr>';
    });
    html+='</tbody></table></div><div class="muted xs" style="margin-top:8px">'+list.length+' customers • Tap a row to view profile • <span style="color:var(--warn)">Erase is view only — contact admin (affects follow-ups)</span></div>';
    el.innerHTML=html;
  }
  window.openCustomer = async function(id){
    const pane=$("custProfile"); if(!pane) return;
    pane.classList.remove("hidden");
    pane.innerHTML='<div class="skeleton" style="height:180px"></div>';
    const cust = CACHE.customers.find(c=> (c.customerId||c.customer_id)===id) || {customerId:id};
    let html='<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px"><div><h2 style="font-size:16px">'+esc(cust.name||id)+'</h2><p class="muted xs" style="margin:4px 0 0">Customer since '+(cust.createdAt?new Date(cust.createdAt).toLocaleDateString():"—")+' • '+esc(id)+'</p></div><button class="btn ghost small" onclick="document.getElementById(\'custProfile\').classList.add(\'hidden\')">Close</button></div>';
    html+='<div class="divider"></div>';
    html+='<div class="grid" style="grid-template-columns:1fr 1fr;gap:12px"><div class="kpi" style="padding:12px"><div class="n" style="font-size:14px">—</div><div class="l">Conversations</div></div><div class="kpi" style="padding:12px"><div class="n" style="font-size:14px">Memory</div><div class="l">Profile</div></div></div>';
    html+='<div style="margin-top:14px" class="card" style="background:var(--bg-subtle)"><h3>Memory</h3><div class="muted xs" style="margin-bottom:8px">Human-readable, GDPR-ready. Explicit memories are user-provided.</div><div class="grid" style="grid-template-columns:1fr 1fr;gap:12px"><div><div class="muted xs" style="text-transform:uppercase;letter-spacing:.06em">Personal</div><div style="margin-top:6px;font-size:13px;line-height:1.6">Name: '+(cust.name||"—")+'<br>Email: '+(cust.email||"—")+'</div></div><div><div class="muted xs" style="text-transform:uppercase;letter-spacing:.06em">Preferences</div><div style="margin-top:6px;font-size:13px;line-height:1.6">No explicit preferences yet.</div></div></div><div class="muted xs" style="margin-top:10px">Source: Portal • <span style="color:var(--warn)">View only — contact admin to erase (affects follow-ups)</span></div></div>';
    // Recent conversations for this customer via conversations list
    try{
      const convs = await api("GET","/conversations");
      const mine = (convs.conversations||[]).filter(c=> (c.customer_id||c.customerId)===id || !id);
      html+='<div class="card"><h3>Recent conversations</h3>';
      if(!mine.length) html+=emptyState("No conversations yet.", "Conversations for this customer will appear here.", "", "");
      else { html+='<div class="table-wrap"><table><thead><tr><th>ID</th><th>Messages</th><th>Updated</th></tr></thead><tbody>'; mine.slice(0,5).forEach(c=>{ html+='<tr><td class="mono xs">'+esc(c.conversation_id||c.conversationId||c.id||"—")+'</td><td>'+esc(String(c.message_count||c.messageCount||0))+'</td><td class="muted xs">'+(c.updated_at?new Date(c.updated_at).toLocaleDateString():"—")+'</td></tr>'; }); html+='</tbody></table></div>'; }
      html+='</div>';
    }catch{}
    pane.innerHTML=html;
    pane.scrollIntoView({behavior:"smooth", block:"nearest"});
  };
  window.eraseCustomer = async function(id){ toast("View only — contact admin to erase. Erasing affects follow-ups & attribution."); return; };
  // --- Conversations ---
  async function loadConversations(){
    const pane=$("tab-conversations"); if(!pane) return;
    pane.innerHTML=skeleton(4);
    try{
      const d=await api("GET","/conversations");
      const list=d.conversations||[];
      CACHE.conversations=list;
      if(!list.length){
        pane.innerHTML='<div class="card"><h3>Conversations</h3>'+emptyState("No conversations yet.", "When customers start talking to XEVEN, their conversations will appear here.", "", "")+'</div>'; return;
      }
      let html='<div class="card"><div class="card-head"><h3>Conversations</h3><div class="row" style="gap:8px;flex:0 0 auto"><input id="convSearch" placeholder="Search customer or ID..." style="width:220px" oninput="filterConvs()"><button class="btn ghost small" onclick="loadConversations()">Refresh</button></div></div>';
      html+='<div style="display:grid;grid-template-columns:320px 1fr;gap:14px;min-height:420px">';
      html+='<div style="border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--surface)"><div style="padding:10px 12px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between"><b style="font-size:13px">Customers</b><span class="pill" style="font-size:11px">'+list.length+' total</span></div><div id="convList" style="max-height:520px;overflow:auto"></div></div>';
      html+='<div style="border:1px solid var(--line);border-radius:10px;background:var(--surface);display:flex;flex-direction:column"><div id="convDetailHead" style="padding:14px 16px;border-bottom:1px solid var(--line)"><span class="muted">Select a conversation</span></div><div id="convDetailBody" style="flex:1;padding:16px;overflow:auto;min-height:200px" class="muted">—</div><div style="padding:10px 12px;border-top:1px solid var(--line);display:flex;gap:8px"><input id="convReply" placeholder="Reply as XEVEN (test)..." style="flex:1" onkeydown="if(event.key===\'Enter\') sendConvReply()"><button class="btn ghost small" onclick="sendConvReply()">Send</button></div></div>';
      html+='</div></div>';
      pane.innerHTML=html;
      renderConvList(list);
      // auto select first
      if(list.length) openConv(list[0].conversation_id || list[0].conversationId || list[0].id);
      // wire search
      window.filterConvs = function(){
        const q=($("convSearch")?.value||"").toLowerCase().trim();
        if(!q) return renderConvList(list);
        const f=list.filter(c=> String(c.customer_id||c.customerId||"").toLowerCase().includes(q) || String(c.conversation_id||c.conversationId||"").toLowerCase().includes(q));
        renderConvList(f);
      };
    }catch(e){ pane.innerHTML=errorState(e.message, "loadConversations()"); }
  }
  function renderConvList(list){
    const el=$("convList"); if(!el) return;
    if(!list.length){ el.innerHTML='<div class="empty" style="margin:12px;border:0"><p>No matches</p></div>'; return; }
    el.innerHTML=list.map(c=>{
      const cid=esc(c.conversation_id||c.conversationId||c.id||"—"); const cust=esc(c.customer_id||c.customerId||"—"); const upd=c.updated_at?new Date(c.updated_at).toLocaleString():"—"; const count=c.message_count||c.messageCount||0;
      return '<div data-act="open-conv" data-id="'+esc(cid)+'" style="padding:12px 14px;border-bottom:1px solid var(--line);cursor:pointer;transition:.12s" onmouseenter="this.style.background=\'var(--bg-subtle)\'" onmouseleave="this.style.background=\'transparent\'"><div style="display:flex;justify-content:space-between;gap:8px"><b style="font-size:13px">'+cust+'</b><span class="muted xs">'+count+' msgs</span></div><div class="muted xs" style="margin-top:4px">'+cid+'</div><div class="muted xs">'+upd+'</div></div>';
    }).join("");
  }
  let _openConvId=null;
  window.openConv = async function(cid){
    _openConvId=cid;
    const head=$("convDetailHead"); const body=$("convDetailBody");
    if(head) head.innerHTML='<div style="display:flex;align-items:center;gap:10px"><b>'+esc(cid)+'</b><span class="pill" style="font-size:10px">'+esc(_openConvId)+'</span><span class="spacer"></span><span class="status ok">Active</span></div><div class="muted xs" style="margin-top:4px">Conversation • Channel: api • Messages will appear here when available</div>';
    if(body) body.innerHTML='<div class="skeleton" style="height:120px"></div>';
    // Portal doesn't expose message fetch; show metadata and try to synthesize from conversation store via fallback?
    // We attempt to fetch via knowledge search? No. Show placeholder plus offer test.
    try{
      const list=CACHE.conversations||[]; const cur=list.find(c=> (c.conversation_id||c.conversationId||c.id)===cid);
      let html='';
      if(cur){
        html+='<div class="grid" style="grid-template-columns:1fr 1fr;gap:10px"><div class="kpi" style="padding:12px"><div class="n" style="font-size:14px">'+esc(String(cur.message_count||0))+'</div><div class="l">Messages</div></div><div class="kpi" style="padding:12px"><div class="n" style="font-size:14px">'+esc(cur.customer_id||cur.customerId||"—")+'</div><div class="l">Customer</div></div></div>';
        html+='<div style="margin-top:12px" class="card" style="background:var(--bg-subtle)"><h3>What XEVEN did</h3><p class="muted" style="margin:0;line-height:1.6">This conversation has '+esc(String(cur.message_count||0))+' messages. Full transcript is stored server-side and used for context. Use the preview on the Agent page or the input below to test how XEVEN responds to this customer type.</p><div class="muted xs" style="margin-top:8px">Updated: '+(cur.updated_at?new Date(cur.updated_at).toLocaleString():"—")+' • Channel: '+esc(cur.channel||"api")+'</div></div>';
        html+='<div class="card"><h3>Test a follow-up</h3><p class="muted xs" style="margin:0 0 8px">Send a message as this customer to see how XEVEN would reply right now.</p><div class="row"><input id="convTestInput" placeholder="Ask as '+esc(cur.customer_id||"customer")+'..." style="flex:1"><button class="btn primary small" onclick="sendConvTest()">Test</button></div><div id="convTestOut" style="margin-top:10px" class="muted"></div></div>';
      } else {
        html=emptyState("Conversation not found", "This conversation may have been archived.", "", "");
      }
      if(body) body.innerHTML=html;
    }catch(e){ if(body) body.innerHTML=errorState(e.message); }
  };
  window.sendConvReply = function(){ const v=$("convReply")?.value.trim(); if(!v) return; toast("Use Agent preview for live test — this is a read-only operational view."); if($("convReply")) $("convReply").value=""; };
  window.sendConvTest = async function(){
    const inp=$("convTestInput"); const out=$("convTestOut"); if(!inp||!out) return; const t=inp.value.trim(); if(!t) return;
    out.innerHTML='<span class="muted">Thinking…</span>';
    try{ const r=await api("POST","/chat/test",{message:t, messages:[{role:"user", content:t}]}); out.innerHTML='<div style="border:1px solid var(--line);border-radius:8px;padding:10px;background:var(--surface-2);margin-top:8px"><b class="muted xs">XEVEN</b><div style="margin-top:4px">'+esc(r.reply)+'</div></div>'; }catch(e){ out.innerHTML='<span style="color:var(--bad)">'+esc(e.message)+'</span>'; }
  };
  // --- Followups ---
  async function loadFollowups(){
    const pane=$("tab-followups"); if(!pane) return;
    pane.innerHTML=skeleton(3);
    try{
      const d=await api("GET","/follow-ups");
      const jobs=d.jobs||d.followUps||[];
      CACHE.followups=jobs;
      const counts={scheduled:0,sent:0,failed:0,pending:0,completed:0};
      jobs.forEach(j=>{ const s=(j.status||"").toLowerCase(); if(s in counts) counts[s]++; else counts.pending++; });
      let html='<div class="card"><div class="card-head"><h3>Follow-ups</h3><span class="pill">'+jobs.length+' total</span></div><div class="grid" style="grid-template-columns:repeat(5,minmax(0,1fr));gap:10px">';
      Object.entries(counts).forEach(([k,v])=>{ html+='<div class="kpi" style="padding:12px"><div class="n" style="font-size:16px">'+v+'</div><div class="l">'+esc(k)+'</div></div>'; });
      html+='</div><p class="muted xs" style="margin:10px 0 0">Pending → Scheduled → Sent → Completed. Failed jobs retry per your policy.</p></div>';
      if(!jobs.length){
        html+=emptyState("No follow-ups yet.", "When XEVEN schedules a follow-up (cart, lead), it will appear here.", "", "");
      } else {
        html+='<div class="card"><div class="table-wrap"><table><thead><tr><th>Customer</th><th>Email</th><th>Kind</th><th>Status</th><th>Attempts</th><th>Next send</th></tr></thead><tbody>';
        jobs.forEach(j=>{
          const cust=esc(j.customer_id||j.customerId||"—"); const email=esc(j.email||"—"); const kind=esc(j.kind||"—"); const st=esc(j.status||"—"); const attempts=esc((j.attempts||0)+"/"+(j.max_attempts||j.maxAttempts||"—")); const next=j.next_send_at?new Date(j.next_send_at).toLocaleString():"—";
          const badge = st.toLowerCase()==="scheduled"?"warn":st.toLowerCase()==="sent"?"ok":st.toLowerCase()==="failed"||st.toLowerCase()==="dropped"?"bad":"neutral";
          html+='<tr><td><b>'+cust+'</b></td><td>'+email+'</td><td><span class="pill" style="font-size:10px">'+kind+'</span></td><td><span class="status '+badge+'">'+st+'</span></td><td>'+attempts+'</td><td class="muted xs">'+next+'</td></tr>';
        });
        html+='</tbody></table></div></div>';
      }
      pane.innerHTML=html;
    }catch(e){ // if flag disabled, show gated
      if(String(e.message).toLowerCase().includes("disabled")||String(e.message).includes("feature_disabled")){
        pane.innerHTML=emptyState("Follow-ups disabled", "Ask your founder to enable edit_followup for this business.", "", "");
      } else pane.innerHTML=errorState(e.message, "loadFollowups()");
    }
  }
  // --- Website ---
  async function loadWebsite(){
    const pane=$("tab-website"); if(!pane) return;
    pane.innerHTML=skeleton(3);
    try{
      const me = ME || await api("GET","/me");
      const siteUrl = me.settings?.siteUrl || me.settings?.site_url || "";
      // Try guide
      let guide=null; try{ const g=await api("GET","/site/guide"); guide=g.guide; }catch{}
      let html='';
      html+='<div class="card"><div class="card-head"><div><h2 style="font-size:16px">Website</h2><p class="muted" style="margin:4px 0 0">Teach XEVEN your website — guided workflow, not technical config.</p></div>'+(guide?'<span class="status ok"><span class="dot ok"></span> Synced</span>':'<span class="status neutral">Not synced</span>')+'</div>';
      html+='<label>Website URL<input id="siteUrl" value="'+esc(siteUrl||"")+'" placeholder="https://example.com"></label>';
      html+='<div class="row" style="margin-top:8px"><button class="btn primary" onclick="analyzeSite()">Start learning</button><button class="btn ghost" onclick="previewGuide()">Preview Guide</button><span id="siteMsg" class="muted xs"></span></div>';
      html+='<div id="siteProgress" style="margin-top:14px"></div>';
      html+='<div id="siteGuidePreview" style="margin-top:10px"></div>';
      html+='</div>';
      // Knowledge health for website
      try{
        const k=await api("GET","/knowledge");
        const items=k.items||[];
        const count=items.length;
        html+='<div class="card"><h3>Knowledge from website</h3><div class="grid"><div class="kpi" style="padding:12px"><div class="n" style="font-size:16px">'+count+'</div><div class="l">Chunks</div></div><div class="kpi" style="padding:12px"><div class="n" style="font-size:16px">'+(guide? 'Yes' : 'No')+'</div><div class="l">Guide</div></div><div class="kpi" style="padding:12px"><div class="n" style="font-size:16px">'+(guide?.updatedAt? new Date(guide.updatedAt).toLocaleDateString() : '—')+'</div><div class="l">Last sync</div></div></div></div>';
      }catch{}
      if(guide){
        html+='<div class="card"><h3>Current guide</h3><div class="code" style="max-height:220px;overflow:auto">'+esc(JSON.stringify(guide, null, 2).slice(0,3000))+'</div></div>';
      }
      pane.innerHTML=html;
    }catch(e){ pane.innerHTML=errorState(e.message, "loadWebsite()"); }
  }
  window.analyzeSite = async function(){
    const u=$("siteUrl")?.value.trim(); const m=$("siteMsg"); const prog=$("siteProgress");
    if(!u||!/^https?:\/\//i.test(u)){ if(m) m.textContent="Provide https:// URL"; toast("Provide https:// URL"); return; }
    if(m) m.textContent="Learning…";
    if(prog){
      prog.innerHTML='<div class="progress" style="margin-top:8px"><i id="siteProgBar" style="width: 18%"></i></div><div class="muted xs" style="margin-top:6px" id="siteProgText">Crawling website • Pages discovered • Content indexed • Knowledge generated</div>';
      // animated polling (repo had no progress, local adds perceived performance)
      let pct=18; const iv=setInterval(function(){
        pct=Math.min(92, pct+ Math.random()*14); var bar=document.getElementById("siteProgBar"); if(bar) bar.style.width=pct+"%";
        var txt=document.getElementById("siteProgText"); if(txt && pct>42) txt.textContent="Indexing content • Generating FAQs • Building guide overlay";
        if(pct>=92) clearInterval(iv);
      }, 420); prog._iv=iv;
    }
    try{
      const r=await api("POST","/site/analyze",{siteUrl:u});
      if(prog && prog._iv) clearInterval(prog._iv);
      if(prog) {
        var bar=document.getElementById("siteProgBar"); if(bar) bar.style.width="100%";
        setTimeout(function(){
          if(m) m.textContent="Learned "+(r.products?.length??r.total??"")+" products";
          if(prog) prog.innerHTML='<div class="pill" style="background:var(--ok-bg);border-color:var(--ok-border);color:var(--ok)"><span class="dot ok"></span> Fully synced • '+(r.products?.length??"")+' products • '+(r.knowledge?.length??"")+' chunks</div><div style="margin-top:8px" class="row"><button class="btn ghost small" onclick="loadWebsite()">Refresh</button><button class="btn ghost small" data-act="go-tab-portal" data-tab="knowledge">View Knowledge</button> <button class="btn primary small" onclick="previewGuide()">Preview Guide</button></div>';
          toast("Website learned");
        }, 320);
      }
    }catch(e){
      if(prog && prog._iv) clearInterval(prog._iv);
      if(m) m.textContent=e.message; if(prog) prog.innerHTML=errorState(e.message); toast(e.message);
    }
  };
  window.previewGuide = async function(){
    const el=$("siteGuidePreview"); if(!el) return; el.innerHTML='<div class="skeleton" style="height:40px"></div>';
    try{ const r=await api("GET","/site/guide"); if(!r.guide) el.innerHTML='<span class="muted">No guide yet</span>'; else el.innerHTML='<div class="code">'+esc(JSON.stringify(r.guide,null,2).slice(0,4000))+'</div>'; }catch(e){ el.innerHTML='<span style="color:var(--bad)">'+esc(e.message)+'</span>'; }
  };
  // --- Voice ---
  async function loadVoice(){
    const pane=$("tab-voice"); if(!pane) return;
    pane.innerHTML=skeleton(4);
    try{
      const d=await api("GET","/voice/settings");
      CACHE.voice=d;
      const call=d.call||{}; const echo=d.echo||{};
      let html='';
      html+='<div class="card"><div class="card-head"><div><h2 style="font-size:16px">Voice</h2><p class="muted" style="margin:4px 0 0">Premium AI voice — phone-ready when you are.</p></div><span class="status '+(echo.enabled!==false?"ok":"neutral")+'"><span class="dot '+(echo.enabled!==false?"ok":"neutral")+'"></span> '+(echo.enabled!==false?"Active":"Not configured")+'</span></div>';
      html+='<div class="row"><div><label>Greeting<input id="voiceGreeting" value="'+esc(call.greetingTemplate||"")+'" placeholder="Hello, thank you for calling..."></label></div><div><label>Handoff phone<input id="voicePhone" value="'+esc(call.handoffPhone||"")+'"></label></div></div>';
      html+='<div class="row"><div><label>Handoff email<input id="voiceEmail" type="email" value="'+esc(call.handoffEmail||"")+'"></label></div><div><label>Language<select id="voiceLang"><option value="en" '+(echo.defaultLanguage==="en"?"selected":"")+'>en</option><option value="es" '+(echo.defaultLanguage==="es"?"selected":"")+'>es</option><option value="fr" '+(echo.defaultLanguage==="fr"?"selected":"")+'>fr</option><option value="de" '+(echo.defaultLanguage==="de"?"selected":"")+'>de</option><option value="auto" '+(echo.defaultLanguage==="auto"?"selected":"")+'>auto</option></select></label></div><div><label>Sidecar<input id="voiceSidecar" value="'+esc(echo.sidecarUrl||"")+'" placeholder="http://127.0.0.1:8765"></label></div></div>';
      html+='<label>Initial prompt<input id="voicePrompt" value="'+esc(echo.initialPrompt||"")+'" placeholder="XEVEN Style..."></label>';
      html+='<div class="row"><div><label>Speech voice<select id="voiceModel">'
        +["piper","elevenlabs","openai","melo"].map(m=>'<option value="'+m+'"'+(echo.model===m?"selected":"")+'>'+m+"</option>").join("")
        +'</select></label><p class="muted xs" style="margin:6px 0 0">melo speaks 6 languages locally — needs its sidecar, else falls through.</p></div></div>';
      html+='<label style="display:flex;align-items:center;gap:8px;margin-top:8px"><input type="checkbox" id="voiceWordTs" '+(echo.wordTimestamps?"checked":"")+' style="width:auto;margin:0"> <span class="muted" style="font-size:13px">Word timestamps</span></label>';
      html+='<div class="row" style="margin-top:12px"><button class="btn primary" onclick="saveVoice()">Save voice settings</button><button class="btn ghost" onclick="testVoice()">▶ Test</button><span id="voiceMsg" class="muted xs"></span></div>';
      html+='</div>';
      // Sidecar health (repo had echo/tts fallbacks — local surfaces live status)
      html+='<div class="card" id="voiceHealth" style="border-style:dashed"><h3>Sidecar health</h3><div class="muted xs">Checking '+esc(echo.sidecarUrl||"http://127.0.0.1:8765")+'…</div><div class="skeleton" style="height:16px;margin-top:8px"></div></div>';
      // Advanced
      html+='<details class="card"><summary style="cursor:pointer;font-weight:600;font-size:13px">Advanced configuration</summary><div style="margin-top:12px" class="muted xs">Sidecar health, model, and echo config live here. Keep defaults unless directed.</div><div style="margin-top:10px" class="code">Sidecar: '+(echo.sidecarUrl||"—")+' • Model: '+(echo.model||"turbo")+'\nGreeting: '+(call.greetingTemplate||"—").slice(0,120)+'</div></details>';
      pane.innerHTML=html;
      // gated: voice is add-on (voice_channel) or scale/unlimited — otherwise view-only with purchase CTA
      const canEditVoice = (()=>{
        const plan = (ME && ME.plan) || "launch";
        const addons = CACHE.addons || [];
        const hasVoice = addons.some(a=> a.key==="voice_channel" && a.enabled) || addons.some(a=> a.key==="multilanguage" && a.enabled);
        return hasVoice || plan==="scale" || plan==="unlimited" || plan==="growth" && hasVoice; // growth needs addon, scale/unlimited auto
      })();
      try{
        if(!canEditVoice){
          pane.querySelectorAll("input, select, textarea, button[onclick*='saveVoice']").forEach(function(el){ if(el.tagName==="BUTTON"){ el.disabled=true; el.title="View only — purchase Voice Channel"; el.style.opacity=".45"; el.textContent="View only — purchase required"; } else { el.disabled=true; el.title="View only — purchase Voice Channel"; el.style.opacity=".6"; } });
          const head=pane.querySelector(".card .card-head");
          if(head && !head.querySelector("#voiceLock")){ const lock=document.createElement("span"); lock.id="voiceLock"; lock.className="pill"; lock.style.background="var(--warn-bg)"; lock.style.borderColor="var(--warn-border)"; lock.style.color="#92400e"; lock.textContent="Add-on required"; head.appendChild(lock); }
          // add purchase hint
          if(!pane.querySelector("#voicePurchaseHint")){
            const hint=document.createElement("div"); hint.id="voicePurchaseHint"; hint.className="card"; hint.style.background="var(--warn-bg)"; hint.style.borderColor="var(--warn-border)"; hint.innerHTML='<b style="color:#92400e">Voice is restricted — purchase Voice Channel add-on</b><p class="muted xs" style="margin:6px 0 0">Enable via Integrations → Voice Channel or upgrade to Scale/Unlimited. Sidecar 24/7 at '+esc(echo.sidecarUrl||"http://127.0.0.1:8765")+'.</p><button class="btn primary small" data-act="go-tab-portal" data-tab="integrations">Go to Integrations</button>';
            pane.insertBefore(hint, pane.children[1]);
          }
        } else {
          const head=pane.querySelector(".card .card-head");
          if(head){
            const lock=head.querySelector("#voiceLock"); if(lock) lock.remove();
            if(!head.querySelector("#voiceLive")){
              const live=document.createElement("span"); live.id="voiceLive"; live.className="pill"; live.style.background="var(--ok-bg)"; live.style.borderColor="var(--ok-border)"; live.style.color="var(--ok)"; live.innerHTML='<span class="dot ok"></span> Live 24/7'; head.appendChild(live);
            }
          }
          const hint=pane.querySelector("#voicePurchaseHint"); if(hint) hint.remove();
        }
      }catch{}
      // fetch sidecar health async
      (async function(){
        try{
          var h=await fetch(API_ORIGIN+"/api/health/echo").then(function(r){return r.json()}).catch(function(){return {sidecar:{available:false}}});
          var av=h.sidecar && h.sidecar.available;
          var el=document.getElementById("voiceHealth");
          if(el) el.innerHTML='<h3>Sidecar health <span class="status '+(av?"ok":"warn")+'"><span class="dot '+(av?"ok":"warn")+'"></span> '+(av?"Available":"Unavailable")+'</span></h3><div class="muted xs">'+esc(av?"Echo transcribe + TTS ready — voice calls will work.":("Sidecar not reachable at "+(echo.sidecarUrl||"127.0.0.1:8765")+" — set ECHO_SIDECAR_URL and run echo sidecar."))+'</div><div style="margin-top:8px" class="row"><button class="btn ghost small" onclick="loadVoice()">Retry check</button><span class="muted xs">Provider: openai-compatible • fallback mock</span></div>';
        }catch{}
      })();
      // Load recent calls/transcripts
      try{
        const calls=await api("GET","/voice/calls");
        const list=calls.calls||[];
        let ch='<div class="card"><h3>Recent calls</h3>';
        if(!list.length) ch+=emptyState("No calls yet.", "When customers call, transcripts will appear here.", "", "");
        else {
          ch+='<div class="table-wrap"><table><thead><tr><th>Customer</th><th>Phone</th><th>Status</th><th>Lang</th><th>Handoff?</th></tr></thead><tbody>';
          list.slice(0,10).forEach(c=>{ ch+='<tr><td>'+esc(c.customer_id||c.customerId||"—")+'</td><td>'+esc(c.phone||"—")+'</td><td><span class="pill">'+esc(c.status||"—")+'</span></td><td>'+esc(c.language||"—")+'</td><td>'+(c.handoff_requested?"Yes":"No")+'</td></tr>'; });
          ch+='</tbody></table></div>';
        }
        ch+='</div>';
        pane.innerHTML+=ch;
      }catch{}
      try{
        const tx=await api("GET","/voice/transcripts");
        const list=tx.transcripts||[];
        let ch='<div class="card"><h3>Recent transcripts</h3>';
        if(!list.length) ch+=emptyState("No transcripts yet.", "Transcripts from voice calls will appear here.", "", "");
        else {
          ch+='<div class="table-wrap"><table><thead><tr><th>Customer</th><th>Lang</th><th>Text</th><th>Notes</th></tr></thead><tbody>';
          list.slice(0,10).forEach(t=>{ ch+='<tr><td>'+esc(t.customer_id||"?")+'</td><td>'+esc(t.language||"?")+'</td><td style="max-width:300px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc((t.transcript||"").slice(0,120))+'</td><td><button class="btn ghost small" data-note="'+esc(t.transcript_id||"")+'" onclick="transcriptNotes(this)">Notes</button></td></tr>'; });
          ch+='</tbody></table></div>';
        }
        ch+='</div>';
        pane.innerHTML+=ch;
      }catch{}
    }catch(e){ pane.innerHTML=errorState(e.message, "loadVoice()"); }
  }
  window.saveVoice = async function(){
    const canEdit = (()=>{
      const plan=(ME&&ME.plan)||"launch";
      const addons=CACHE.addons||[];
      return addons.some(a=>a.key==="voice_channel"&&a.enabled) || plan==="scale" || plan==="unlimited";
    })();
    if(!canEdit){ toast("Voice is add-on — purchase Voice Channel in Integrations"); return; }
    const payload={
      greetingTemplate:$("voiceGreeting")?.value||"",
      handoffPhone:$("voicePhone")?.value||"",
      handoffEmail:$("voiceEmail")?.value||"",
      defaultLanguage:$("voiceLang")?.value||"en",
      sidecarUrl:$("voiceSidecar")?.value||"",
      initialPrompt:$("voicePrompt")?.value||"",
      wordTimestamps:!!$("voiceWordTs")?.checked,
      ttsModel:$("voiceModel")?.value||"",
      echoEnabled:true
    };
    try{
      await api("PUT","/voice/settings",payload);
      toast("Voice saved — live 24/7");
      const m=$("voiceMsg"); if(m) m.textContent="Saved";
    }catch(e){ toast(e.message); }
  };
  window.testVoice = function(){ toast("Voice test — check sidecar at "+($("voiceSidecar")?.value||"http://127.0.0.1:8765")); };
  window.transcriptNotes = async function(btn){
    try{
      var id = btn.getAttribute("data-note") || "";
      var tr = btn.closest("tr");
      var open = tr && tr.nextElementSibling && tr.nextElementSibling.classList.contains("note-row");
      var old = tr && tr.parentNode.querySelector(".note-row");
      if (old) old.remove();
      if (open || !id) return;
      btn.disabled = true;
      var prev = btn.textContent;
      btn.textContent = "…";
      var r = await api("POST", "/voice/notes", { transcriptId: id });
      var n = (r && r.notes) || { summary: "", actionItems: [], keyPoints: [] };
      var html = '<tr class="note-row"><td colspan="4"><b>Summary.</b> ' + esc(n.summary || "—");
      html += '<br><b>Actions.</b> ' + ((n.actionItems || []).map(esc).join(" · ") || "—");
      html += '<br><b>Points.</b> ' + ((n.keyPoints || []).map(esc).join(" · ") || "—") + '</td></tr>';
      tr.insertAdjacentHTML("afterend", html);
      btn.textContent = "Hide";
      btn.disabled = false;
      btn.onclick = function(){ var x = tr.nextElementSibling; if (x && x.classList.contains("note-row")) x.remove(); btn.textContent = "Notes"; btn.onclick = function(){ window.transcriptNotes(btn); }; };
    }catch(e){ toast(e.message); btn.disabled = false; btn.textContent = "Notes"; }
  };
  // --- Schedule ---
  async function loadSchedule(){
    const pane=$("tab-schedule"); if(!pane) return;
    pane.innerHTML=skeleton(4);
    try{
      const d=await api("GET","/chrono/schedule");
      const s=d.schedule||{}; CACHE.chrono=d;
      const tz=s.timezone||"UTC"; const slot=s.slotDuration||60; const buf=s.bufferMinutes||0; const notice=s.minNoticeMinutes||0; const seats=s.maxSeatsPerSlot||1; const hosts=(s.hosts||[]).map(h=>h.name).join(", ");
      let html='';
      html+='<div class="card"><div class="card-head"><div><h2 style="font-size:16px">Schedule</h2><p class="muted" style="margin:4px 0 0">Business hours, availability, and holidays — calendar-based.</p></div><span class="pill">'+esc(tz)+'</span></div>';
      html+='<div class="row"><div><label>Timezone<input id="chTimezone" value="'+esc(tz)+'"></label></div><div><label>Slot (min)<input id="chSlot" type="number" value="'+slot+'"></label></div><div><label>Buffer<input id="chBuffer" type="number" value="'+buf+'"></label></div><div><label>Notice<input id="chNotice" type="number" value="'+notice+'"></label></div><div><label>Seats<input id="chSeats" type="number" value="'+seats+'"></label></div></div>';
      html+='<label>Hosts<input id="chHosts" value="'+esc(hosts)+'" placeholder="Alice, Bob"></label>';
      html+='<div id="chWeekly" style="margin-top:12px"></div>';
      html+='<div class="row" style="margin-top:12px"><button class="btn primary" onclick="saveSchedule()">Save schedule</button><span id="chMsg" class="muted xs"></span></div>';
      html+='</div>';
      html+='<div class="card"><h3>Overrides</h3><div class="row"><div><label>Date<input id="ovDate" type="date"></label></div><div><label>Closed<select id="ovClosed"><option value="0">Open</option><option value="1">Closed</option></select></label></div><div><label>Open<input id="ovOpen" placeholder="10:00"></label></div><div><label>Close<input id="ovClose" placeholder="16:00"></label></div><div><label>Reason<input id="ovReason" placeholder="Holiday"></label></div><div style="flex:0 0 auto;padding-top:18px"><button class="btn ghost small" onclick="addOverride()">Add</button></div></div><div id="ovTable" style="margin-top:12px"></div></div>';
      html+='<div class="card"><h3>Live preview</h3><div id="chPreview" style="background:var(--bg);color:var(--ink-2);border:1px solid var(--line);border-radius:8px;padding:12px;white-space:pre-wrap;min-height:70px" class="mono xs">Loading…</div><div style="margin-top:8px"><button class="btn ghost small" onclick="refreshPreview()">Refresh preview</button></div></div>';
      pane.innerHTML=html;
      // weekly
      let wh=''; const days=["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];
      days.forEach(day=>{
        const v=(s.weekly&&s.weekly[day]||[]).map(b=>b.start+"-"+b.end).join(", ");
        wh+='<div class="row"><div style="min-width:90px"><label>'+day+'</label></div><div><input data-day="'+day+'" value="'+esc(v)+'" placeholder="09:00-17:00"></div></div>';
      });
      const whEl=$("chWeekly"); if(whEl) whEl.innerHTML=wh;
      // gated: Chrono is core (bookings:true all plans) but show Live 24/7 badge when editable — otherwise hint to upgrade
      const canEditSched = (()=>{
        const plan=(ME&&ME.plan)||"launch";
        return true; // Chrono live for all — 24/7 with XEVEN AI (bookings:true)
      })();
      try{
        if(!canEditSched){
          pane.querySelectorAll("input, select, textarea, button[onclick*='saveSchedule'], button[onclick*='addOverride']").forEach(function(el){
            if(el.tagName==="BUTTON"){ el.disabled=true; el.title="View only — upgrade to Growth"; el.style.opacity=".45"; if(el.textContent.includes("Save")) el.textContent="View only"; if(el.textContent.includes("Add")) el.textContent="View only"; }
            else { el.disabled=true; el.title="View only"; el.style.opacity=".6"; }
          });
          const head=pane.querySelector(".card .card-head");
          if(head && !head.querySelector("#schedLock")){ const lock=document.createElement("span"); lock.id="schedLock"; lock.className="pill"; lock.style.background="var(--warn-bg)"; lock.style.borderColor="var(--warn-border)"; lock.style.color="#92400e"; lock.textContent="Add-on required"; head.appendChild(lock); }
        } else {
          const head=pane.querySelector(".card .card-head");
          if(head){
            const lock=head.querySelector("#schedLock"); if(lock) lock.remove();
            if(!head.querySelector("#schedLive")){
              const live=document.createElement("span"); live.id="schedLive"; live.className="pill"; live.style.background="var(--ok-bg)"; live.style.borderColor="var(--ok-border)"; live.style.color="var(--ok)"; live.innerHTML='<span class="dot ok"></span> Live 24/7'; head.appendChild(live);
            }
          }
        }
      }catch{}
      // overrides
      renderOverrides(d.overrides||[]);
      refreshPreview();
    }catch(e){ pane.innerHTML=errorState(e.message, "loadSchedule()"); }
  }
  function renderOverrides(list){
    const el=$("ovTable"); if(!el) return;
    if(!list.length){ el.innerHTML=emptyState("No overrides.", "Holidays and special hours will appear here.", "", ""); return; }
    let h='<div class="table-wrap"><table><thead><tr><th>Date</th><th>Status</th><th>Hours</th><th></th></tr></thead><tbody>';
    list.forEach(o=>{ h+='<tr><td>'+esc(o.date||o.override_id||"—")+'</td><td><span class="pill">'+(o.is_closed?"Closed":"Open")+'</span></td><td>'+esc((o.open_time||"")+" - "+(o.close_time||""))+'</td><td><button class="btn ghost small" data-act="delete-override" data-id="'+esc(o.override_id)+'">✕</button></td></tr>'; });
    h+='</tbody></table></div>'; el.innerHTML=h;
  }
  window.saveSchedule = async function(){
    const payload={
      timezone:$("chTimezone")?.value||"UTC",
      slotDuration:parseInt($("chSlot")?.value)||60,
      bufferMinutes:parseInt($("chBuffer")?.value)||0,
      minNoticeMinutes:parseInt($("chNotice")?.value)||0,
      maxSeatsPerSlot:parseInt($("chSeats")?.value)||1,
      hosts:($("chHosts")?.value||"").split(",").map(s=>s.trim()).filter(Boolean).map(name=>({name})),
      weekly:parseWeekly()
    };
    try{
      await api("PUT","/chrono/schedule",payload);
      toast("Schedule saved — Chrono live 24/7");
      const m=$("chMsg"); if(m) m.textContent="Saved";
      refreshPreview();
    }catch(e){ toast(e.message); }
  };
  function parseWeekly(){ const w={}; document.querySelectorAll("#chWeekly input[data-day]").forEach(el=>{ const d=el.dataset.day, r=el.value.trim(); if(!r) w[d]=[]; else w[d]=r.split(",").map(s=>s.trim()).map(p=>{ const [a,b]=p.split("-"); return{start:a.trim(), end:b.trim()}; }); }); return w; }
  window.addOverride = async function(){
    const body={ date:$("ovDate")?.value, is_closed:$("ovClosed")?.value==="1", open_time:$("ovOpen")?.value, close_time:$("ovClose")?.value, reason:$("ovReason")?.value };
    if(!body.date){ toast("Date required"); return; }
    try{ await api("POST","/chrono/overrides",body); toast("Override saved"); loadSchedule(); }catch(e){ toast(e.message); }
  };
  window.deleteOverride = async function(id){
    if(!confirm("Remove override?")) return;
    try{ await api("DELETE","/chrono/overrides/"+encodeURIComponent(id)); toast("Removed"); loadSchedule(); }catch(e){ toast(e.message); }
  };
  window.refreshPreview = async function(){
    const el=$("chPreview"); if(!el) return; el.textContent="Loading…";
    try{ const d=await api("GET","/chrono/availability?days=7"); const avail=d.availability||d; el.textContent=JSON.stringify(avail, null, 2).slice(0,3000); }catch(e){ el.textContent="Preview unavailable: "+e.message; }
  };
  // --- Integrations ---
  async function loadIntegrations(){
    const pane=$("tab-integrations"); if(!pane) return;
    pane.innerHTML=skeleton(3);
    try{
      const d=await api("GET","/addons").catch(()=>({addons:[]}));
      const list=d.addons||[];
      CACHE.addons=list;
      let html='<div class="card"><div class="card-head"><h3>Integrations</h3><span class="status ok"><span class="dot ok"></span> Operational</span></div><p class="muted" style="margin:0 0 12px">Each integration has clear status — connected or not.</p>';
      html+='<div class="grid" style="grid-template-columns:1fr 1fr;gap:12px">';
      if(!list.length){
        html+=emptyState("No integrations yet.", "Connect payments, calendars, and tools to extend XEVEN.", "", "");
      } else {
        list.forEach(a=>{
          const name=esc(a.meta?.label||a.key); const desc=esc(a.meta?.description||""); const enabled=!!a.enabled;
          const icon = a.key==="voice_channel"?"◍":a.key==="multilanguage"?"◎":a.key==="custom_behaviour"?"✦":"⬣";
          html+='<div style="border:1px solid var(--line);border-radius:10px;padding:16px;background:var(--surface)"><div style="display:flex;align-items:center;gap:10px"><div style="width:36px;height:36px;border-radius:8px;background:var(--surface-2);border:1px solid var(--line);display:grid;place-items:center">'+icon+'</div><div><b>'+name+'</b><div class="muted xs">'+desc+'</div></div><span class="spacer"></span><span class="status '+(enabled?"ok":"neutral")+'">'+(enabled?"Connected":"Not connected")+'</span></div><div class="row" style="margin-top:12px"><button class="btn '+(enabled?"ghost":"primary")+' small" data-act="toggle-addon" data-id="'+esc(a.key)+'" data-on="'+(!enabled)+'">'+(enabled?"Configure":"Connect")+'</button>'+(enabled?'<button class="btn ghost small" data-act="toggle-addon" data-id="'+esc(a.key)+'" data-on="false">Disconnect</button>':"")+'</div></div>';
        });
      }
      html+='</div></div>';
      // Widget snippet — real integration (repo-learned: show both widget + tracker, copy UX)
      try{
        const bizId = ME.business?.businessId || ME.business?.business_id || "";
        const widgetCode='&lt;script src="'+location.origin+'/widget/xeven-widget.js" data-public-key="YOUR_PUBLIC_KEY" defer&gt;&lt;/script&gt;';
        const trackerCode='&lt;script src="'+location.origin+'/widget/xeven-tracker.js" data-public-key="YOUR_PUBLIC_KEY"&gt;&lt;/script&gt;';
        html+='<div class="card"><div class="card-head"><h3>Website widget</h3><span class="status ok"><span class="dot ok"></span> Live</span></div><p class="muted" style="margin:0 0 10px">Your chat widget — paste on your site. Grounded answers only. Tracker records page_view automatically; call <code class="key" style="padding:2px 6px">XevenTracker.productView</code> for rich context.</p><div class="code" id="widgetSnippet" style="position:relative">'+widgetCode+'<br>'+trackerCode+'</div><div class="row" style="margin-top:10px"><button class="btn ghost small" onclick="copyWidgetSnippet()">Copy snippet</button><button class="btn ghost small" data-act="go-tab-portal" data-tab="website">Sync website →</button></div><p class="muted xs" style="margin-top:8px">Public key is per-business — ask admin at <b>Admin → Settings → Rotate key</b> if needed.</p></div>';
      }catch{}
      pane.innerHTML=html;
      // view-only lock — integrations affect channels, portal views only
      try{
        pane.querySelectorAll("button[onclick*='toggleAddon']").forEach(function(b){ b.disabled=true; b.title="View only — contact admin to change integrations"; b.style.opacity=".45"; b.textContent="View only"; });
        const head=pane.querySelector(".card .card-head");
        if(head && !head.querySelector("#intLock")){ const lock=document.createElement("span"); lock.id="intLock"; lock.className="pill"; lock.style.background="var(--warn-bg)"; lock.style.borderColor="var(--warn-border)"; lock.style.color="#92400e"; lock.textContent="View only"; head.appendChild(lock); }
      }catch{}
    }catch(e){ pane.innerHTML=errorState(e.message, "loadIntegrations()"); }
  }
  window.copyWidgetSnippet=function(){
    var el=document.getElementById("widgetSnippet"); if(!el) return;
    var text=el.innerText||el.textContent; if(navigator.clipboard) navigator.clipboard.writeText(text).then(function(){toast("Snippet copied");});
    else { var ta=document.createElement("textarea"); ta.value=text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); toast("Snippet copied"); }
  };
  window.toggleAddon = async function(key, enabled){ toast("View only — contact admin to change integrations"); return; };
  // --- Business ---
  async function loadBusiness(){
    const pane=$("tab-business"); if(!pane) return;
    pane.innerHTML=skeleton(3);
    try{
      const me=await api("GET","/me"); ME=me;
      const s=me.settings||{};
      let html='';
      html+='<div class="card"><div class="card-head"><div><h2 style="font-size:16px">Business</h2><p class="muted" style="margin:4px 0 0">Your brand — identity, contact and presence. AI config lives under AI.</p></div><span class="status ok">Live</span></div>';
      html+='<div class="row"><div><label>Business name<input id="bizNameInput" value="'+esc(me.business.name||"")+'"></label></div><div><label>Website<input id="bizWebsite" value="'+esc(s.siteUrl||"")+'" placeholder="https://example.com"></label></div></div>';
      html+='<div class="row"><div><label>Contact email<input id="sEmail" type="email" value="'+esc(s.contactEmail||"")+'"></label></div><div><label>Phone<input id="sPhone" value="'+esc(s.contactPhone||"")+'"></label></div></div>';
      html+='<label>Business hours<input id="sHours" value="'+esc(s.businessHours||"")+'" placeholder="Mon–Sat 9:00–19:00"></label>';
      html+='<div class="row"><div><label>Timezone<input id="bizTimezone" value="'+esc(s.timezone||"UTC")+'" placeholder="Europe/London"></label></div><div><label>Address<input id="bizAddress" value="'+esc(s.address||"")+'" placeholder="123 High St, London"></label></div></div>';
      html+='<div class="row" style="margin-top:12px"><button class="btn primary" onclick="saveBusiness()">Save business</button><span id="bizMsg" class="muted xs"></span></div>';
      html+='</div>';
      html+='<div class="card"><h3>AI vs Business</h3><p class="muted" style="margin:0;line-height:1.6">Business is your identity (name, contact, hours). AI is how XEVEN behaves (Agent, Knowledge, Behaviors, Memory). This separation keeps your AI operating system clean — edit AI under <b>AI</b> in the sidebar.</p></div>';
      pane.innerHTML=html;
    }catch(e){ pane.innerHTML=errorState(e.message, "loadBusiness()"); }
  }
  window.saveBusiness = async function(){
    const patch={
      contactEmail:$("sEmail")?.value.trim(), contactPhone:$("sPhone")?.value.trim(), businessHours:$("sHours")?.value||"",
      siteUrl:$("bizWebsite")?.value.trim()
    };
    try{
      await api("PUT","/settings", patch);
      toast("Business saved"); const m=$("bizMsg"); if(m){ m.textContent="Saved — live"; setTimeout(()=>m.textContent="",3000); }
    }catch(e){ toast(e.message); const m=$("bizMsg"); if(m) m.textContent=e.message; }
  };
  async function loadPreferences(){
    const pane=$("tab-preferences"); if(!pane) return;
    pane.innerHTML=skeleton(4);
    try{
      const me=await api("GET","/me"); const s=me.settings||{};
      let html='';
      html+='<div class="card"><div class="card-head"><div><h2 style="font-size:16px">Preferences</h2><p class="muted" style="margin:4px 0 0">How XEVEN contacts customers — email identity and follow-up cadence.</p></div><span class="pill">Per-business</span></div>';
      html+='<div class="card"><h3>Send-as email (SMTP)</h3><p class="muted xs" style="margin:0 0 10px">XEVEN never sends from itself — it sends from your address.</p>';
      html+='<div class="row"><div><label>SMTP host<input id="smtpHost" value="'+esc(s.smtpHost||"")+'" placeholder="smtp.gmail.com"></label></div><div><label>Port<input id="smtpPort" type="number" value="'+esc(s.smtpPort||587)+'"></label></div></div>';
      html+='<div class="row"><div><label>SMTP user<input id="smtpUser" type="email" value="'+esc(s.smtpUser||"")+'"></label></div><div><label>Password<input id="smtpPass" type="password" placeholder="(unchanged)"></label></div></div>';
      html+='<div class="row"><div><label>From name<input id="smtpFrom" value="'+esc(s.smtpFromName||"")+'" placeholder="Your Store"></label></div><div style="flex:0 0 auto;padding-top:18px"><button class="btn ghost" onclick="testEmail()">Send test email</button></div></div>';
      html+='</div>';
      html+='<div class="card"><h3>Follow-ups</h3><p class="muted xs" style="margin:0 0 10px">Cart and lead nudges — only if SMTP is configured and a customer has an email.</p><div class="row"><div><label>Enabled<select id="fuOn"><option value="0" '+(s.followUp?.enabled?"":"selected")+'>Off</option><option value="1" '+(s.followUp?.enabled?"selected":"")+'>On</option></select></label></div><div><label>First after (days)<input id="fuFirst" type="number" value="'+esc(s.followUp?.firstDays??1)+'"></label></div><div><label>Max attempts<input id="fuMax" type="number" value="'+esc(s.followUp?.maxAttempts??3)+'"></label></div><div><label>Interval (days)<input id="fuInt" type="number" value="'+esc(s.followUp?.intervalDays??2)+'"></label></div></div></div>';
      html+='<div class="row" style="margin-top:8px"><button class="btn primary" onclick="savePreferences()">Save preferences</button><span id="prefMsg" class="muted xs"></span></div>';
      try{
        const dg=await api("GET","/digest-settings").catch(()=>null);
        if(dg){
          html+='<div class="card" style="margin-top:14px"><h3>Weekly digest</h3><p class="muted xs" style="margin:0 0 8px">Monday summary of chats, revenue and health — sent to you, not customers.</p><label>Digest email<input id="digestEmail" type="email" value="'+esc(dg.email||s.digestEmail||"")+'" placeholder="owner@example.com"></label><button class="btn ghost small" onclick="saveDigest()">Save digest</button><span id="digestMsg" class="muted xs" style="margin-left:8px"></span></div>';
        }
      }catch{}
      html+='</div>';
      pane.innerHTML=html;
    }catch(e){ pane.innerHTML=errorState(e.message, "loadPreferences()"); }
  }
  window.savePreferences = async function(){
    const patch={
      smtpHost:$("smtpHost")?.value||"", smtpPort:Number($("smtpPort")?.value)||587, smtpUser:$("smtpUser")?.value||"", smtpFromName:$("smtpFrom")?.value||"",
      enabled: $("fuOn")?.value==="1", firstDays:Number($("fuFirst")?.value)||1, maxAttempts:Number($("fuMax")?.value)||3, intervalDays:Number($("fuInt")?.value)||2
    };
    if($("smtpPass")?.value) patch.smtpPassword=$("smtpPass").value;
    try{
      await api("PUT","/settings", {smtpHost:patch.smtpHost, smtpPort:patch.smtpPort, smtpUser:patch.smtpUser, smtpFromName:patch.smtpFromName, ...(patch.smtpPassword?{smtpPassword:patch.smtpPassword}:{})});
      await api("PUT","/follow-up-config",{enabled:patch.enabled, firstDays:patch.firstDays, maxAttempts:patch.maxAttempts, intervalDays:patch.intervalDays});
      toast("Preferences saved"); const m=$("prefMsg"); if(m){ m.textContent="Saved"; setTimeout(()=>m.textContent="",3000); }
    }catch(e){ toast(e.message); const m=$("prefMsg"); if(m) m.textContent=e.message; }
  };
  window.testEmail = async function(){ try{ const r=await api("POST","/settings/test-email",{}); toast(r.sent?"Sent":"Failed"); }catch(e){ toast(e.message); } };
  window.saveDigest = async function(){
    const em=$("digestEmail")?.value.trim(); if(!em){ toast("Enter email"); return; }
    try{ await api("PUT","/digest-settings",{email:em}); toast("Digest saved"); const m=$("digestMsg"); if(m) m.textContent="Saved"; }catch(e){ toast(e.message); }
  };
  // --- Account ---
  async function loadAccount(){
    const pane=$("tab-account"); if(!pane) return;
    pane.innerHTML=skeleton(3);
    try{
      const me=ME||await api("GET","/me");
      const flags=me.flags||{};
      let html='<div class="card"><h3>Account</h3><div style="display:flex;gap:12px;align-items:center"><div class="ava" style="width:36px;height:36px;border-radius:8px;background:var(--ink);color:var(--bg);display:grid;place-items:center;font-weight:700">●</div><div><b>'+esc(me.user.email)+'</b><div class="muted xs">Portal • '+esc(me.business.name||"")+' • '+(me.business.businessId||"")+'</div></div><span class="spacer"></span><span class="pill">'+esc(me.plan||"launch")+'</span></div></div>';
      html+='<div class="card"><h3>Your enabled capabilities</h3><div class="muted xs" style="margin-bottom:10px">Founder-controlled flags — what you may self-manage.</div>';
      const entries=Object.entries(flags);
      if(!entries.length) html+='<span class="muted">No flags</span>';
      else {
        entries.forEach(([k,v])=>{
          html+='<div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line)"><span class="mono xs">'+esc(k)+'</span><span class="status '+(v?"ok":"neutral")+'">'+(v?"on":"off")+'</span></div>';
        });
      }
      html+='</div>';
      html+='<div class="card"><h3>Plan</h3><div class="grid"><div class="kpi" style="padding:12px"><div class="n" style="font-size:14px">'+esc(me.plan||"launch")+'</div><div class="l">Plan</div></div><div class="kpi" style="padding:12px"><div class="n" style="font-size:14px">Unified</div><div class="l">Brain</div></div><div class="kpi" style="padding:12px"><div class="n" style="font-size:14px">'+(me.maxRoles===null?"∞":me.maxRoles||"—")+'</div><div class="l">Roles</div></div></div></div>';
      pane.innerHTML=html;
    }catch(e){ pane.innerHTML=errorState(e.message, "loadAccount()"); }
  }
  // Init — repo-learned polish: magnetic, keyboard, offline
  function initPortalChrome(){
    // magnetic primary buttons
    document.addEventListener("mousemove", function(e){
      var btn=e.target.closest&&e.target.closest(".btn.primary");
      if(!btn) return; var r=btn.getBoundingClientRect();
      btn.style.setProperty("--x", ((e.clientX - r.left)/r.width*100)+"%");
      btn.style.setProperty("--y", ((e.clientY - r.top)/r.height*100)+"%");
    });
    // keyboard: arrows move tabs
    var tabsEl=$("tabs"); if(tabsEl){
      tabsEl.addEventListener("keydown", function(e){
        if(!["ArrowRight","ArrowLeft","ArrowUp","ArrowDown"].includes(e.key)) return;
        var btns=[].slice.call(tabsEl.querySelectorAll("button.nav-item"));
        var idx=btns.findIndex(function(b){return b.classList.contains("active")});
        if(idx===-1) return; var dir=(e.key==="ArrowRight"||e.key==="ArrowDown")?1:-1;
        var next=(idx+dir+btns.length)%btns.length; e.preventDefault(); btns[next].click(); btns[next].focus();
      });
    }
    // offline banner
    var ob=document.createElement("div"); ob.id="offlineBanner";
    ob.style.cssText="position:fixed;top:0;left:0;right:0;z-index:99;background:var(--warn-bg);border-bottom:1px solid var(--warn-border);color:#92400e;padding:8px 14px;text-align:center;font-size:12px;font-weight:700;display:none;backdrop-filter:blur(8px)";
    ob.textContent="You are offline — XEVEN will retry when back online";
    document.body.prepend(ob);
    function syncOffline(){ ob.style.display=navigator.onLine?"none":"block"; }
    window.addEventListener("online", syncOffline); window.addEventListener("offline", syncOffline); syncOffline();
    // health pill → overview
    var hp=$("healthPill"); if(hp){ hp.title="All systems operational — view overview"; hp.addEventListener("click", function(){ selectTab("overview"); }); }
  }
  document.readyState==="loading" ? document.addEventListener("DOMContentLoaded", initPortalChrome) : initPortalChrome();
  // --- robust login wiring: ensure form submit works even if DOM not ready at script load ---
  function attachLoginHandlers(){
    const form = document.getElementById("loginForm");
    if(form && !form._xevenBound){
      form._xevenBound = true;
      form.addEventListener("submit", e=>{ e.preventDefault(); login(); });
    }
    const pass = document.getElementById("liPass");
    if(pass && !pass._xevenBound){
      pass._xevenBound = true;
      pass.addEventListener("keydown", e=>{ if(e.key==="Enter"){ e.preventDefault(); login(); }});
    }
    const email = document.getElementById("liEmail");
    if(email && !email._xevenBound){
      email._xevenBound = true;
      email.addEventListener("keydown", e=>{ if(e.key==="Enter"){ e.preventDefault(); login(); }});
    }
    // also ensure button click directly triggers login (covers case where form submit not wired)
    const btn = form?.querySelector('button[type="submit"]');
    if(btn && !btn._xevenBound){
      btn._xevenBound = true;
      btn.addEventListener("click", e=>{
        e.preventDefault();
        login();
      });
    }
  }
  // try immediately and on DOM ready
  attachLoginHandlers();
  if(document.readyState==="loading"){
    document.addEventListener("DOMContentLoaded", attachLoginHandlers);
  }
  // retry shortly after (handles slow parse / cached HTML)
  setTimeout(attachLoginHandlers, 50);
  setTimeout(attachLoginHandlers, 300);
  if(TOKEN){
    api("GET","/me").then(m=>{ ME=m; enter(); }).catch(()=>{ show($("loginView"), true); show($("appView"), false); });
  }
  $("sidebarOpen")?.addEventListener("click", ()=> $("sidebar")?.classList.add("open"));
  $("sidebarClose")?.addEventListener("click", ()=> $("sidebar")?.classList.remove("open"));
  document.addEventListener("click", e=>{ const s=$("sidebar"); if(innerWidth<=980 && s?.classList.contains("open") && !s.contains(e.target) && e.target!==$("sidebarOpen")) s.classList.remove("open"); });
})();

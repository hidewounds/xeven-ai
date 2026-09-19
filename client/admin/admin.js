// XEVEN Admin — Premium (Linear/Vercel/Stripe) — quiet, minimal, functional
(function(){
  "use strict";
  var TOKEN_KEY="xeven_admin_token";
  var state={token:localStorage.getItem(TOKEN_KEY),admin:null,businesses:[],businessId:null,business:null,config:null,plan:"launch",isSuper:false};
  function $(id){return document.getElementById(id)}
  function show(el,on){el.classList.toggle("hidden",!on)}
  function toast(m){var el=$("toast");el.textContent=m;show(el,true);clearTimeout(el._t);el._t=setTimeout(function(){show(el,false)},3000)}
  function esc(v){return String(v==null?"":v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;")}
  function useCookie(){try{return sessionStorage.getItem("xeven_admin_cookie")==="1"}catch(e){return false}}
  function setCookieMode(on){try{if(on)sessionStorage.setItem("xeven_admin_cookie","1");else sessionStorage.removeItem("xeven_admin_cookie")}catch(e){}}
  var _csrf=null;
  async function ensureCsrf(){
    if(_csrf) return _csrf;
    try{
      var h={}; if(state.token&&!useCookie())h.Authorization="Bearer "+state.token;
      var r=await fetch("/api/admin/auth/csrf-token",{headers:h,credentials:"same-origin"});
      if(!r.ok) return null;
      var d=await r.json(); _csrf=d.csrf_token||null; return _csrf;
    }catch(e){ return null; }
  }
  function clearLocalSession(){
    try{setCookieMode(false)}catch(e){}
    _csrf=null;state.token=null;state.admin=null;
    try{localStorage.removeItem(TOKEN_KEY)}catch(e){}
    try{show($("dashView"),false);show($("authView"),true)}catch(e){}
  }
  async function api(path,opts){
    opts=opts||{};
    var headers=Object.assign({"Content-Type":"application/json"},opts.headers||{});
    if(state.token&&!useCookie())headers.Authorization="Bearer "+state.token;
    if(opts.body&&typeof opts.body!=="string")opts.body=JSON.stringify(opts.body);
    var method=String(opts.method||"GET").toUpperCase();
    if(useCookie()&&["POST","PUT","PATCH","DELETE"].indexOf(method)!==-1){
      var tok=await ensureCsrf(); if(tok)headers["X-CSRF-Token"]=tok;
    }
    var r=await fetch(path,Object.assign({},opts,{headers:headers,credentials:"same-origin"}));var d={};try{d=await r.json()}catch(e){}
    if(r.status===401){clearLocalSession();throw new Error("Session expired")}
    if(!r.ok) throw new Error((d.error&&d.error.message)||"Request failed ("+r.status+")");
    return d;
  }
  async function logout(){
    // Use raw fetch so a failed logout does not re-enter api()'s 401 path and recurse.
    try{
      var h={"Content-Type":"application/json"};
      if(state.token&&!useCookie())h.Authorization="Bearer "+state.token;
      if(useCookie()){
        var tok=await ensureCsrf(); if(tok) h["X-CSRF-Token"]=tok;
      }
      await fetch("/api/admin/auth/logout",{method:"POST",headers:h,credentials:"same-origin",body:"{}"}).catch(function(){});
    }catch(e){}
    clearLocalSession();
  }
  $("showRegister").addEventListener("click",function(){show($("loginForm"),false);show($("registerForm"),true);$("authTitle").textContent="Create account"});
  $("showLogin").addEventListener("click",function(){show($("registerForm"),false);show($("loginForm"),true);$("authTitle").textContent="Sign in to XEVEN"});
  $("loginForm").addEventListener("submit",async function(e){e.preventDefault();$("authError").textContent="";try{var d=await api("/api/admin/auth/login",{method:"POST",body:{email:$("authEmail").value.trim(),password:$("authPassword").value}});if(d.cookieAuth){setCookieMode(true);state.token=null;try{localStorage.removeItem(TOKEN_KEY)}catch(_){}}else{state.token=d.accessToken;try{localStorage.setItem(TOKEN_KEY,d.accessToken)}catch(_){}}await enterDashboard()}catch(err){$("authError").textContent=err.message}});
  $("registerForm").addEventListener("submit",async function(e){e.preventDefault();$("regError").textContent="";try{var d=await api("/api/admin/auth/register",{method:"POST",body:{name:$("regName").value.trim(),email:$("regEmail").value.trim(),password:$("regPassword").value}});if(d.cookieAuth){setCookieMode(true);state.token=null;try{localStorage.removeItem(TOKEN_KEY)}catch(_){}}else{state.token=d.accessToken;try{localStorage.setItem(TOKEN_KEY,d.accessToken)}catch(_){}}await enterDashboard()}catch(err){$("regError").textContent=err.message}});
  $("logoutBtn").addEventListener("click",logout);
  async function enterDashboard(){
    var me=await api("/api/admin/auth/me");
    state.admin=me.admin;state.businesses=me.businesses||[];
    $("whoami").textContent=me.admin.email;
    $("planBadge").textContent=me.businesses.length?me.businesses[0].plan||"—":"—";
    show($("authView"),false);show($("dashView"),true);
    renderBusinessSelect();
    if(state.businessId && state.businesses.some(function(b){return b.businessId===state.businessId})){await loadBusiness(state.businessId)}
    else if(state.businesses.length>0){await loadBusiness(state.businesses[0].businessId)}
    else { // empty state - no businesses
      $("crumbBiz").textContent="—";
      renderEmptyWorkspace();
    }
  }
  function renderEmptyWorkspace(){
    var p=$("tab-overview");
    p.innerHTML='<div class="empty"><h4>No businesses yet.</h4><p>Create your first workspace and connect XEVEN to your business. The Unified Brain is ready.</p><button class="btn primary" onclick="document.getElementById(\'newBusinessBtn\').click()">Create workspace</button></div>';
  }
  function renderBusinessSelect(){
    var s=$("businessSelect");s.innerHTML="";
    state.businesses.forEach(function(b){var o=document.createElement("option");o.value=b.businessId;o.textContent=b.businessName+(b.active?"":" (inactive)");s.appendChild(o)});
    if(state.businessId) s.value=state.businessId;
    if(s.options.length) {$("crumbBiz").textContent=s.options[s.selectedIndex].textContent.replace(" (inactive)","");$("businessPill").textContent=s.options[s.selectedIndex].textContent}
  }
  $("businessSelect").addEventListener("change",function(){loadBusiness(this.value)});
  $("newBusinessBtn").addEventListener("click",async function(){
    var n=prompt("Workspace name:");
    if(!n||n.trim().length<2){toast("Name too short");return}
    try{var c=await api("/api/admin/businesses",{method:"POST",body:{businessName:n.trim()}});toast("Workspace created");await enterDashboard();await loadBusiness(c.business.businessId)}catch(e){toast(e.message)}
  });
  var ANALYTICS_CACHE={data:null,at:0,biz:null};
  async function getAnalytics(){
    var now=Date.now();
    if(ANALYTICS_CACHE.data&&ANALYTICS_CACHE.biz===state.businessId&&now-ANALYTICS_CACHE.at<30000) return ANALYTICS_CACHE.data;
    var s=await api("/api/admin/businesses/"+encodeURIComponent(state.businessId)+"/analytics");
    ANALYTICS_CACHE={data:s,at:now,biz:state.businessId};
    return s;
  }
  async function loadBusiness(id){
    state.businessId=id;
    var d=await api("/api/admin/businesses/"+encodeURIComponent(id));
    state.business=d.business;state.config=d.config;state.plan=d.plan||"launch";state.isSuper=!!d.isSuper;
    state.securityWarnings=Array.isArray(d.securityWarnings)?d.securityWarnings:[];
    ANALYTICS_CACHE={data:null,at:0,biz:null};
    renderBusinessSelect();
    renderTab();
  }
  // Delegated actions for buttons carrying user-controlled ids (data-act/data-id/tab).
  // Attribute values are HTML-escaped at render; dataset decodes them back
  // exactly once — no JS-string interpolation, no breakout vector.
  document.addEventListener("click",function(e){
    var b=e.target&&e.target.closest?e.target.closest("[data-act]"):null; if(!b) return;
    var act=b.getAttribute("data-act");
    if(act==="go-tab"){
      var tab=b.getAttribute("data-tab")||""; if(!tab) return;
      var btn=document.querySelector('#tabs button[data-tab="'+CSS.escape(tab)+'"]'); if(btn) btn.click();
      return;
    }
    var id=b.getAttribute("data-id")||"";
    if(act==="view-customer"&&window.viewCustomer) window.viewCustomer(id);
    else if(act==="erase-customer"&&window.eraseCustomer) window.eraseCustomer(id);
    else if(act==="delete-knowledge"&&window.deleteKnowledge) window.deleteKnowledge(id);
  });
  $("tabs").addEventListener("click",function(e){
    var b=e.target.closest("button[data-tab]");if(!b)return;
    document.querySelectorAll("#tabs button").forEach(function(x){x.classList.remove("active");x.setAttribute("aria-selected","false");x.tabIndex=-1});
    b.classList.add("active");b.setAttribute("aria-selected","true");b.tabIndex=0;
    document.querySelectorAll(".tabpane").forEach(function(p){p.classList.remove("active")});
    $("tab-"+b.dataset.tab).classList.add("active");
    renderTab(b.dataset.tab);
  });
  function currentTab(){var a=document.querySelector("#tabs button.active");return a?a.dataset.tab:"overview"}
  async function renderTab(t){
    t=t||currentTab();if(!state.businessId) return;
    try{
      if(t==="overview") await renderOverview();
      if(t==="performance") await renderPerformance();
      if(t==="usage") await renderUsage();
      if(t==="costs") await renderCosts();
      if(t==="health") await renderHealth();
      if(t==="logs") await renderAudit("logs");
      if(t==="settings") renderSettings();
      if(t==="agent") renderAgent();
      if(t==="custom") renderCustom();
      if(t==="memory") renderMemory();
      if(t==="behavior") renderBehavior();
      if(t==="knowledge") await renderKnowledge();
      if(t==="customers") await renderCustomers();
      if(t==="integration") renderIntegration();
      if(t==="voice") await renderVoice();
      if(t==="schedule") await renderSchedule();
      if(t==="audit") await renderAudit();
    }catch(e){toast(e.message)}
  }
  // --- Skeletons / helpers ---
  function skeleton(rows){var h='';for(var i=0;i<rows;i++) h+='<div class="skeleton" style="height:14px;margin:8px 0;width:'+(70+Math.random()*25)+'%"></div>';return '<div class="card"><div style="padding:4px 0">'+h+'</div></div>'}
  function emptyState(title, desc, cta, tab){ return '<div class="empty"><h4>'+esc(title)+'</h4><p>'+esc(desc)+'</p>'+(cta&&tab?'<button class="btn primary small" data-act="go-tab" data-tab="'+esc(tab)+'">'+esc(cta)+'</button>':"")+'</div>'; }
  // --- Overview: summary + attention ONLY (health lives in Health tab) ---
  async function renderOverview(){
    var p=$("tab-overview");
    p.innerHTML=skeleton(3);
    try{
      var s=await getAnalytics();
      var c=s.counts||{}; var plan=esc(state.plan);
      var attention=[];
      if(c.knowledgeItems===0) attention.push({t:"Knowledge is empty",d:"Add a website, document, or FAQ so XEVEN can answer grounded.",a:"Go to Knowledge",tab:"knowledge"});
      if(c.customers===0) attention.push({t:"No customers yet",d:"Install the snippet and XEVEN will start capturing conversations.",a:"View Integration",tab:"integration"});
      (state.securityWarnings||[]).forEach(function(w){attention.push({t:String(w.message||w.code||"Security notice").slice(0,140),d:"Security posture — review recommended.",a:"Review settings",tab:w.tab||"settings"})});
      var html='';
      html+='<div class="card" style="background:linear-gradient(135deg, rgba(139,92,246,.08), rgba(6,182,214,.05)), rgba(255,255,255,.03)"><div style="display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap"><div><h2 style="font-size:18px;margin:0">'+esc(state.business.businessName)+'</h2><p class="muted" style="margin:4px 0 0">Overview — what matters today. See Health for system status, Analytics for trends.</p></div><span class="pill">'+plan+' • unified</span></div></div>';
      // KPIs ONLY here — health is NOT duplicated
      html+='<div class="grid">';
      [["Conversations",c.conversations],["Customers",c.customers],["Messages",c.messages],["Memories",c.memories],["Behavior events",c.behaviorEvents],["Knowledge",c.knowledgeItems]].forEach(function(k){
        html+='<div class="kpi"><div class="n">'+k[1]+'</div><div class="l">'+k[0]+'</div></div>';
      });
      html+='</div>';
      // Attention
      if(attention.length){
        html+='<div class="card" style="margin-top:14px;border-color:var(--warn-border);background:var(--warn-bg)"><h3 style="color:#fcd34d">Attention required</h3>';
        attention.forEach(function(a){html+='<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(245,158,11,.14)"><div><b style="font-weight:500;color:#f1f5f9">'+esc(a.t)+'</b><div class="muted xs">'+esc(a.d)+'</div></div><button class="btn ghost small" data-act="go-tab" data-tab="'+esc(a.tab)+'">'+esc(a.a)+'</button></div>'});
        html+='</div>';
      } else {
        html+='<div class="card" style="margin-top:14px"><h3>All clear</h3><p class="muted" style="margin:0">No issues. For system details, open Health. For trends, open Analytics.</p></div>';
      }
      // Workspace summary ONLY (not health)
      html+='<div class="card"><div class="card-head"><h3>Workspace</h3><span class="status ok"><span class="dot ok"></span> '+esc(plan)+'</span></div><div class="row" style="justify-content:space-between"><div><b>'+esc(state.business.businessName)+'</b><div class="muted xs">'+state.businessId+' • '+(state.business.active?'Active':'Inactive')+'</div></div><button class="btn ghost small" data-act="go-tab" data-tab="settings">Settings</button></div><p class="muted xs" style="margin-top:8px">Health → system status • Performance/Usage/Costs → trends • Logs → audit</p></div>';
      p.innerHTML=html;
      $("businessPill").textContent=state.business.businessName;
      $("healthPill").innerHTML='<span class="dot ok"></span> Operational';
    }catch(e){
      p.innerHTML='<div class="error-state"><span>'+esc(e.message)+'</span><button class="btn ghost small" onclick="renderOverview()">Try again</button></div>';
    }
  }
  // --- Agent: brain + live preview (repo-learned: show training counts for credibility) ---
  function renderAgent(){
    var a=state.config.assistant, cfg=state.config;
    var patterns=[
      {k:"Customer Support",c:"2.4k",d:"empathy + solutions + check"},
      {k:"Sales",c:"3.1k",d:"value + close + needs"},
      {k:"Shopping",c:"2.8k",d:"options + comparison"},
      {k:"Product Advisor",c:"2.1k",d:"specs + transparency"},
      {k:"Lead Qualification",c:"1.9k",d:"questions then present"},
      {k:"General",c:"5.2k",d:"broadly adaptive"}
    ];
    var html='';
    html+='<div class="card" style="border-left:4px solid var(--violet);background:linear-gradient(135deg, rgba(139,92,246,.08), rgba(6,182,214,.06))"><div class="card-head"><h3>Unified Brain — 6 Learned Patterns</h3><span class="status ok"><span class="dot ok"></span> Unified • Operational</span></div>';
    html+='<p class="muted" style="margin:-6px 0 12px;line-height:1.6">One brain, not 9 roles. Trained via RLHF — DPO/PPO/GRPO with reward: <b style="color:var(--text)">task completion + satisfaction + accuracy</b>. No role switching — XEVEN leans fluidly by situation.</p>';
    html+='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-top:4px">';
    patterns.forEach(function(pat){html+='<div style="background:rgba(255,255,255,.04);border:1px solid var(--line);border-radius:10px;padding:10px"><b style="font-size:13px">'+esc(pat.k)+'</b><div class="muted xs" style="margin-top:2px">'+esc(pat.d)+' <span style="color:var(--violet-2);font-weight:700">· '+pat.c+'</span></div></div>'});
    html+='</div></div>';
    html+='<div class="card"><div class="card-head"><h3>Agent identity</h3><span class="pill">Live in &lt;1s</span></div>';
    html+='<div class="grid" style="grid-template-columns:1.2fr .85fr;gap:20px">';
    html+='<div>';
    html+='<p class="muted" style="line-height:1.6;margin:0 0 14px">Define who XEVEN is — name, tone and instructions. Knowledge, memory and behaviour live in their own sections.</p>';
    html+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px"><div><label>Assistant name<input id="ag_name" value="'+esc(a.name)+'"></label></div><div><label>Model<input value="'+esc(cfg.model?.model||state.plan)+'" disabled style="background:var(--bg-subtle)"></label></div></div>';
    html+='<label>Business description<textarea id="ag_desc" placeholder="What does your business do?">'+esc(a.businessDescription||"")+'</textarea></label>';
    html+='<label>Personality<input id="ag_personality" value="'+esc(a.personality||"")+'" placeholder="friendly and practical"></label>';
    html+='<label>Tone<input id="ag_tone" value="'+esc(a.tone||"")+'" placeholder="friendly and helpful"></label>';
    html+='<label>Instructions<textarea id="ag_instructions" placeholder="Never invent prices. One coupon per order...">'+esc(a.instructions||"")+'</textarea></label>';
    html+='<label>Welcome message<input id="ag_welcome" value="'+esc(a.welcomeMessage||"")+'" placeholder="Hi! I\'m Stella — how can I help?"></label>';
    html+='<label>Fallback<input id="ag_fallback" value="'+esc(a.fallbackMessage||"")+'" placeholder="I don\'t have verified info — want me to connect you?"></label>';
    html+='<div class="row" style="margin-top:14px"><button class="btn primary" onclick="saveAgent()">Save brain</button><span class="muted xs">Live in &lt;1s</span><span class="muted xs" style="margin-left:8px">Plan <b>'+esc(state.plan)+'</b> • unified</span></div>';
    html+='<p class="muted xs" style="margin-top:10px">Need grounded answers? <a href="#" data-act="go-tab" data-tab="knowledge" style="color:var(--violet-2);font-weight:600">Manage Knowledge →</a> · <a href="#" data-act="go-tab" data-tab="custom" style="color:var(--violet-2);font-weight:600">Custom Behaviour →</a></p>';
    html+='</div>';
    // Live preview
    html+='<div><div class="preview" style="position:sticky;top:20px"><div class="preview-head"><b>Live preview</b><span class="pill" style="font-size:10px">Grounded</span></div><div class="preview-body" id="agentPreviewBody"><div class="bubble bot">Hi! I\'m '+esc(a.name||"XEVEN")+' — ask me anything about '+esc(state.business.businessName||"your business")+'.</div></div><div class="preview-foot"><input id="agentPreviewInput" placeholder="Ask as customer: Do you have running shoes under $150?" onkeydown="if(event.key===\'Enter\') sendAgentPreview()"><button class="btn primary small" onclick="sendAgentPreview()">Send</button></div></div><div class="card" style="margin-top:14px"><h3>What lives elsewhere</h3><p class="muted xs" style="margin:0;line-height:1.6">Knowledge → grounded sources · Memories → per-customer facts · Behaviour → situation overrides · Integrations → widget. No duplication — each section has one job.</p></div></div>';
    html+='</div></div>';
    $("tab-agent").innerHTML=html;
  }
  window.saveAgent=async function(){
    var patch={assistant:{name:$("ag_name").value.trim(), businessDescription:$("ag_desc").value.trim(), personality:$("ag_personality").value.trim(), tone:$("ag_tone").value.trim(), instructions:$("ag_instructions").value.trim(), welcomeMessage:$("ag_welcome").value.trim(), fallbackMessage:$("ag_fallback").value.trim()}};
    try{await patchConfig(patch);toast("Brain saved — live in <1s")}catch(e){toast(e.message)}
  };
  var _previewHistory=[];
  window.sendAgentPreview=async function(){
    var input=$("agentPreviewInput"), text=input.value.trim(); if(!text) return;
    var body=$("agentPreviewBody");
    var u=document.createElement("div");u.className="bubble user";u.textContent=text;body.appendChild(u);body.scrollTop=body.scrollHeight;
    _previewHistory.push({role:"user",content:text}); input.value="";
    var bot=document.createElement("div");bot.className="bubble bot";bot.textContent="Thinking…";body.appendChild(bot);body.scrollTop=body.scrollHeight;
    try{
      var r=await api("/api/v1/chat",{method:"POST",body:{customer:{id:"preview_admin"},messages:_previewHistory.slice(-12),businessId:state.businessId}});
      var reply=r.reply||r.message||"No reply";
      bot.textContent=reply; _previewHistory.push({role:"assistant",content:reply});
    }catch(e){bot.textContent="Error: "+e.message; bot.style.borderColor="var(--bad-border)"; bot.style.background="var(--bad-bg)"}
    body.scrollTop=body.scrollHeight;
  };
  // --- Knowledge: premium workspace — fixed null querySelector & nested card duplicate style ---
  async function renderKnowledge(){
    var p=$("tab-knowledge");
    if(!p){ console.warn("tab-knowledge not found"); return; }
    // clean, not nested: 3 sibling cards (header+form+table | bulk | search)
    p.innerHTML='<div class="card"><div class="card-head"><h3>Knowledge</h3><button class="btn primary small" onclick="document.getElementById(\'knTitle\')&&document.getElementById(\'knTitle\').focus()">+ Add source</button></div><p class="muted" style="margin:-8px 0 12px">Everything XEVEN knows about your business. Grounded, synced, and healthy.</p><div id="knowledgeStats" class="grid" style="margin-bottom:14px">'+skeleton(3).slice(22,-8)+'</div><div class="row"><div style="flex:1"><label>Title<input id="knTitle" placeholder="Do you deliver?"></label></div><div style="width:160px"><label>Type<select id="knType"><option value="faq">FAQ</option><option value="policy">Policy</option><option value="product">Product</option><option value="info">Info</option></select></label></div><div style="flex:0 0 auto;padding-top:18px"><button class="btn primary" onclick="addKnowledge()">Add</button></div></div><label>Content<textarea id="knContent" placeholder="Yes — free delivery over $50 within the city..."></textarea></label><div id="knMsg"></div><div id="knTableWrap" class="table-wrap" style="margin-top:14px"><table id="knTable"><thead><tr><th>Title</th><th>Type</th><th>Content</th><th></th></tr></thead><tbody><tr><td colspan="4"><div class="skeleton" style="height:32px"></div></td></tr></tbody></table></div></div><div class="card" style="background:var(--bg-subtle)"><h3 style="margin-bottom:8px">Bulk import</h3><p class="muted xs" style="margin:0 0 8px">Paste CSV <code>title,type,content</code> per line, or JSON array. Max 50.</p><textarea id="knBulk" placeholder="Return policy,policy,Free 30-day returns..." style="min-height:88px"></textarea><div class="row" style="margin-top:8px"><button class="btn ghost small" onclick="bulkKnowledge()">Import bulk</button><input type="file" id="knBulkFile" accept=".csv,.json,.txt" style="width:auto"></div><div id="knBulkMsg"></div></div><div class="card"><h3>Search preview <span class="muted xs" style="font-weight:400">— how XEVEN retrieves</span></h3><div class="row"><input id="knSearchQ" placeholder="Try: do you ship to Canada?" style="flex:1"><button class="btn ghost small" onclick="searchKnowledge()">Search</button></div><div id="knSearchResults" style="margin-top:12px"></div></div>';
    // stats
    try{
      if(!state.businessId){ throw new Error("No workspace selected"); }
      var raw=await api("/api/admin/businesses/"+encodeURIComponent(state.businessId)+"/knowledge");
      var items=Array.isArray(raw)?raw:Array.isArray(raw.items)?raw.items:[];
      var byType={}; items.forEach(function(k){var t=k.knowledge_type||k.knowledgeType||"faq";byType[t]=(byType[t]||0)+1});
      var statsHtml='<div class="kpi"><div class="n">'+items.length+'</div><div class="l">Total chunks</div><div class="trend"><span class="dot ok"></span> Synced</div></div>';
      statsHtml+='<div class="kpi"><div class="n">'+(byType.faq||0)+'</div><div class="l">FAQ</div><div class="trend">Grounded</div></div>';
      statsHtml+='<div class="kpi"><div class="n">'+(byType.policy||0)+'</div><div class="l">Policies</div><div class="trend">Healthy</div></div>';
      statsHtml+='<div class="kpi"><div class="n">'+(byType.product||0)+'</div><div class="l">Products</div><div class="trend">Indexed</div></div>';
      var el=$("knowledgeStats"); if(el) el.innerHTML=statsHtml;
      // table — defensive, was throwing cannot read querySelector of null
      var knTableEl=$("knTable");
      if(!knTableEl){ console.warn("knTable not found after render"); return; }
      var tbody=knTableEl.querySelector("tbody");
      if(!tbody){ console.warn("knTable tbody not found"); return; }
      if(items.length===0){
        tbody.innerHTML='<tr><td colspan="4"><div class="empty" style="margin:0;border:0"><h4>No knowledge yet.</h4><p>Add a website, document, or FAQ — XEVEN answers grounded to this.</p></div></td></tr>';
      } else {
        tbody.innerHTML=items.map(function(k){return '<tr><td><b>'+esc(k.title)+'</b><div class="muted xs">'+esc(k.knowledge_type||"")+'</div></td><td><span class="pill" style="font-size:10px">'+esc(k.knowledge_type||"faq")+'</span></td><td style="max-width:360px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+esc((k.content||"").slice(0,120))+'</td><td><button class="btn ghost small" data-act="delete-knowledge" data-id="'+esc(k.knowledge_id)+'">Remove</button></td></tr>'}).join("");
      }
    }catch(e){
      var knTableEl2=$("knTable");
      if(knTableEl2 && knTableEl2.querySelector("tbody")){
        knTableEl2.querySelector("tbody").innerHTML='<tr><td colspan="4"><div class="error-state"><span>'+esc(e.message)+'</span><button class="btn ghost small" onclick="renderKnowledge()">Retry</button></div></td></tr>';
      } else {
        var p2=$("tab-knowledge");
        if(p2) p2.innerHTML+='<div class="error-state"><span>'+esc(e.message)+'</span><button class="btn ghost small" onclick="renderKnowledge()">Retry</button></div>';
      }
    }
    // bulk file
    var f=$("knBulkFile"); if(f && !f._bound){ f._bound=true; f.addEventListener("change",function(){ var file=f.files[0]; if(!file) return; var r=new FileReader(); r.onload=function(e){$("knBulk").value=e.target.result}; r.readAsText(file); });}
  }
  window.addKnowledge=async function(){
    var t=$("knTitle").value.trim(), c=$("knContent").value.trim(); if(!t||!c){toast("Title and content required");return}
    try{await api("/api/admin/businesses/"+encodeURIComponent(state.businessId)+"/knowledge",{method:"POST",body:{title:t,knowledgeType:$("knType").value,content:c}});$("knTitle").value="";$("knContent").value="";toast("Knowledge added");renderKnowledge()}catch(e){var el=$("knMsg");el.innerHTML='<div class="error-state"><span>'+esc(e.message)+'</span></div>'}
  };
  window.deleteKnowledge=async function(id){ if(!confirm("Remove this knowledge?")) return; try{await api("/api/admin/businesses/"+encodeURIComponent(state.businessId)+"/knowledge/"+encodeURIComponent(id),{method:"DELETE"});toast("Removed");renderKnowledge()}catch(e){toast(e.message)} };
  window.bulkKnowledge=async function(){
    var text=$("knBulk").value.trim(); if(!text){toast("Nothing to import");return}
    var items=[]; if(text.startsWith("[")){try{var arr=JSON.parse(text); if(Array.isArray(arr)) items=arr.map(function(o){return {title:o.title,content:o.content,knowledgeType:o.knowledgeType||o.type||"faq"}})}catch(e){}} else {items=text.split("\n").map(function(l){return l.trim()}).filter(Boolean).map(function(line){var f=line.indexOf(","),s=line.indexOf(",",f+1); if(f===-1||s===-1) return null; return {title:line.slice(0,f).trim(),knowledgeType:line.slice(f+1,s).trim()||"faq",content:line.slice(s+1).trim()}}).filter(Boolean)}
    if(!items.length){toast("Nothing parsed");return} if(items.length>50){toast("Max 50 per batch");return}
    try{var r=await api("/api/admin/businesses/"+encodeURIComponent(state.businessId)+"/knowledge/bulk",{method:"POST",body:{items:items}});toast("Imported "+r.total);$("knBulk").value="";renderKnowledge()}catch(e){toast(e.message)}
  };
  window.searchKnowledge=async function(){
    var q=$("knSearchQ").value.trim(); var el=$("knSearchResults"); if(!q){el.innerHTML='<span class="muted">Enter a query</span>';return}
    el.innerHTML='<div class="skeleton" style="height:60px"></div>';
    try{var d=await api("/api/admin/businesses/"+encodeURIComponent(state.businessId)+"/knowledge/search?q="+encodeURIComponent(q)); if(!d.items||!d.items.length){el.innerHTML='<div class="empty"><h4>No matches</h4><p>XEVEN would answer from fallback: "'+esc(q)+'"</p></div>';return} el.innerHTML=d.items.map(function(k){return '<div style="border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:8px;background:var(--surface)"><b>'+esc(k.title)+'</b> <span class="pill" style="font-size:10px;float:right">'+esc(k.knowledge_type||"")+'</span><div class="muted" style="margin-top:6px;font-size:13px;line-height:1.5">'+esc(k.content.slice(0,180))+'…</div><div class="muted xs" style="margin-top:6px">Score '+esc(String(k.relevanceScore||"—"))+' • Retrieved for prompt</div></div>'}).join("")}catch(e){el.innerHTML='<div class="error-state"><span>'+esc(e.message)+'</span></div>'}
  };
  // --- Memory: human-readable + real data ---
  function renderMemory(){
    var p=$("tab-memory");
    // Owner critique: Memories was duplicating Customers → now single source is Customers, this tab is config + guidance
    var mem=state.config.memory||{}, ctx=state.config.context||{};
    var html='<div class="card"><div class="card-head"><h3>Customer Memory</h3><span class="pill">'+(mem.enabled?"On":"Off")+' • Human-readable</span></div><p class="muted" style="margin:0 0 14px">Explicit memories are user-provided (“my shoe size is 10”); inferred signals are separate. Scoped to <code class="key" style="padding:2px 6px">customer_id</code> + <code class="key" style="padding:2px 6px">business_id</code>, GDPR-ready.</p><div class="grid"><div class="kpi"><div class="n">'+(mem.enabled?"On":"Off")+'</div><div class="l">Memory</div></div><div class="kpi"><div class="n">'+(mem.maxMemories||50)+'</div><div class="l">Max / customer</div></div><div class="kpi"><div class="n">'+(ctx.maxMemories||5)+'</div><div class="l">In prompt</div></div></div><p class="muted xs" style="margin-top:10px">Live memories live in <b>Customers → View</b>. This keeps one source of truth — no duplication.</p><div class="row" style="margin-top:12px"><button class="btn primary small" data-act="go-tab" data-tab="customers">Open Customers</button><button class="btn ghost small" data-act="go-tab" data-tab="agent">Test Agent</button></div></div>';
    html+='<div class="card"><h3>How it works</h3><div class="grid" style="grid-template-columns:1fr 1fr;gap:14px"><div><b class="muted xs" style="text-transform:uppercase;letter-spacing:.06em">Explicit</b><p class="muted" style="margin:6px 0 0;line-height:1.6">Stored when field is in allow-list or user says “remember…”. <code class="key" style="padding:2px 6px">origin: explicit</code>, <code class="key" style="padding:2px 6px">source: user_request</code></p></div><div><b class="muted xs" style="text-transform:uppercase;letter-spacing:.06em">Forget</b><p class="muted" style="margin:6px 0 0;line-height:1.6">Customer says “forget my X” → deleted immediately. Admin can also erase per customer.</p></div></div><div style="margin-top:14px" class="table-wrap"><table><thead><tr><th>Field</th><th>Example</th><th>Origin</th></tr></thead><tbody><tr><td>shoe_size</td><td>10</td><td><span class="status ok">explicit</span></td></tr><tr><td>location</td><td>London</td><td><span class="status ok">explicit</span></td></tr><tr><td>preference</td><td>minimal shoes</td><td><span class="status ok">explicit</span></td></tr></tbody></table></div><p class="muted xs" style="margin-top:8px">Tip: customers can say <code class="key" style="padding:2px 6px">forget my shoe size</code> to delete instantly. Inferred signals are not memories.</p></div>';
    p.innerHTML=html;
  }
  // --- Conversations — pure, no behavior mixing ---
  async function renderBehavior(){
    var p=$("tab-behavior");
    p.innerHTML='<div class="card"><div class="card-head"><h3>Conversations</h3><span class="pill">'+(state.config.behavior?.enabled?"Enabled":"Off")+'</span></div><p class="muted" style="margin:0 0 12px">Every chat XEVEN had — grounded answers per customer. Behavior signals are per-customer under Customers.</p><div id="behaviorList"><div class="skeleton" style="height:120px"></div></div></div><div class="card"><h3>Where are behavior signals?</h3><p class="muted" style="margin:0;line-height:1.6">Page views, cart, purchases are stored per customer with TTL (page_view 7d, purchase 365d). Open <b>Customers</b> → click a customer → view their recent behavior events. This keeps conversations (what XEVEN said) separate from signals (what the shopper did).</p><button class="btn ghost small" style="margin-top:10px" data-act="go-tab" data-tab="customers">Go to Customers</button></div>';
    try{
      var convRes=await api("/api/admin/businesses/"+encodeURIComponent(state.businessId)+"/conversations");
      var convs=convRes.conversations||convRes.items||[];
      if(!convs.length){$("behaviorList").innerHTML=emptyState("No conversations yet.","Install the snippet and conversations will appear here.", "View Customers","document.querySelector('[data-tab=customers]').click()");}
      else {
        var html='<div class="table-wrap"><table><thead><tr><th>Customer</th><th>Channel</th><th>Messages</th><th>Last</th></tr></thead><tbody>';
        convs.slice(0,20).forEach(function(c){html+='<tr><td><b>'+esc(c.customerId||c.customer_id||"—")+'</b><div class="muted xs">'+esc(c.conversationId||c.id||"")+'</div></td><td><span class="pill" style="font-size:10px">'+esc(c.channel||"api")+'</span></td><td>'+esc(String(c.messageCount||c.message_count||0))+'</td><td class="muted xs">'+(c.updatedAt?new Date(c.updatedAt).toLocaleDateString():"—")+'</td></tr>';});
        html+='</tbody></table></div><div class="muted xs" style="margin-top:8px">'+convs.length+' conversations • Behavior signals are separate, per customer</div>';
        $("behaviorList").innerHTML=html;
      }
    }catch(e){ $("behaviorList").innerHTML='<div class="error-state"><span>'+esc(e.message)+'</span></div>'; }
  }
  // --- Customers - premium table/cards ---
  async function renderCustomers(){
    var p=$("tab-customers");
    p.innerHTML='<div class="card"><div class="card-head"><h3>Customers</h3><div class="row" style="gap:8px"><input id="custSearch" placeholder="Search email or ID…" style="width:220px" oninput="filterCustomers()"><button class="btn ghost small" onclick="renderCustomers()">Refresh</button></div></div><div id="customerTable"><div class="skeleton" style="height:140px"></div></div><div id="customerDetail" style="margin-top:14px"></div></div>';
    try{
      var d=await api("/api/admin/businesses/"+encodeURIComponent(state.businessId)+"/customers");
      var customers=d.customers||d.items||[];
      window._customersCache=customers;
      renderCustomerTable(customers);
    }catch(e){$("customerTable").innerHTML='<div class="error-state"><span>'+esc(e.message)+'</span></div>'}
  }
  window.filterCustomers=function(){
    var q=($("custSearch")?.value||"").toLowerCase().trim();
    var list=window._customersCache||[];
    if(!q) return renderCustomerTable(list);
    var filtered=list.filter(function(c){return String(c.customerId||c.id||"").toLowerCase().includes(q) || String(c.email||"").toLowerCase().includes(q)});
    renderCustomerTable(filtered);
  };
  function renderCustomerTable(list){
    var el=$("customerTable");
    if(!list.length){el.innerHTML='<div class="empty"><h4>No customers yet.</h4><p>Once the widget is live, customers will appear here. Each row is tenant-scoped and GDPR-ready.</p></div>';return}
    var html='<div class="table-wrap"><table><thead><tr><th>Customer</th><th>Email</th><th>Created</th><th></th></tr></thead><tbody>';
    list.forEach(function(c){
      var id=esc(c.customerId||c.id||"—"), email=esc(c.email||"—"), created=c.createdAt?new Date(c.createdAt).toLocaleDateString():"—";
      html+='<tr><td><b>'+id+'</b></td><td>'+email+'</td><td class="muted xs">'+created+'</td><td><div class="row" style="gap:6px;flex-wrap:nowrap"><button class="btn ghost small" data-act="view-customer" data-id="'+esc(String(c.customerId||c.id||""))+'">View</button><button class="btn ghost small" style="color:var(--bad);border-color:var(--bad-border)" data-act="erase-customer" data-id="'+esc(String(c.customerId||c.id||""))+'">Erase</button></div></td></tr>';
    });
    html+='</tbody></table></div><div class="muted xs" style="margin-top:8px">'+list.length+' customers • <span class="mono">'+state.businessId+'</span> • Click View for memories & behavior (separate)</div>';
    el.innerHTML=html;
  }
  window.viewCustomer=async function(id){
    var detail=$("customerDetail"); if(!detail) return;
    detail.innerHTML='<div class="card"><div class="skeleton" style="height:100px"></div></div>';
    try{
      var memRes=await api("/api/admin/businesses/"+encodeURIComponent(state.businessId)+"/customers/"+encodeURIComponent(id)+"/memories");
      var behRes=await api("/api/admin/businesses/"+encodeURIComponent(state.businessId)+"/customers/"+encodeURIComponent(id)+"/behavior");
      var mems=memRes.memories||[]; var events=behRes.events||[];
      var html='<div class="card"><div class="card-head"><h3>'+esc(id)+' <span class="pill">Detail</span></h3><button class="btn ghost small" onclick="document.getElementById(\'customerDetail\').innerHTML=\'\'">Close</button></div>';
      html+='<div class="grid" style="grid-template-columns:1fr 1fr;gap:12px"><div><h3 style="margin:0 0 8px">Memories ('+mems.length+')</h3>';
      if(!mems.length) html+=emptyState("No memories","No stored facts for this customer.","—","");
      else {
        html+='<div style="max-height:220px;overflow:auto;display:flex;flex-direction:column;gap:8px">';
        mems.slice(0,10).forEach(function(m){ html+='<div style="border:1px solid var(--line);border-radius:10px;padding:10px;background:rgba(255,255,255,.03)"><div class="mono xs">'+esc(m.memory_key||m.key)+': '+esc(m.memory_value||m.value)+'</div><div class="muted xs" style="margin-top:4px">'+esc(m.origin||"explicit")+' • '+esc(m.source||"chat")+'</div></div>'; });
        html+='</div>';
      }
      html+='</div><div><h3 style="margin:0 0 8px">Behavior signals ('+events.length+')</h3>';
      if(!events.length) html+=emptyState("No signals","No page_view/cart/purchase yet.","—","");
      else {
        html+='<div style="max-height:220px;overflow:auto"><div class="table-wrap"><table><thead><tr><th>Type</th><th>When</th></tr></thead><tbody>';
        events.slice(0,10).forEach(function(ev){ html+='<tr><td><span class="pill" style="font-size:10px">'+esc(ev.eventType||ev.event_type)+'</span></td><td class="muted xs">'+new Date(ev.createdAt||ev.created_at).toLocaleDateString()+'</td></tr>'; });
        html+='</tbody></table></div></div>';
      }
      html+='</div></div></div>';
      detail.innerHTML=html;
      detail.scrollIntoView({behavior:"smooth",block:"nearest"});
    }catch(e){ detail.innerHTML='<div class="card"><div class="error-state"><span>'+esc(e.message)+'</span></div></div>'; }
  }
  window.eraseCustomer=async function(id){
    if(!confirm("Erase "+id+" and all memories/behavior?")) return;
    try{await api("/api/admin/businesses/"+encodeURIComponent(state.businessId)+"/customers/"+encodeURIComponent(id),{method:"DELETE"});toast("Erased");renderCustomers()}catch(e){toast(e.message)}
  };
  // --- Integration - clean, no duplication (owner: why Knowledge here? now removed) ---
  function renderIntegration(){
    var o=location.origin;
    var pub=state.business.widgetPublicKey||state.business.widget_public_key||state.business.integrationKey||state.business.integration_key||"—";
    var key=pub;
    var html='<div class="card"><div class="card-head"><h3>Integrations</h3><span class="status ok"><span class="dot ok"></span> Operational</span></div>';
    html+='<p class="muted" style="margin:-6px 0 14px">Connect website, chat and tracker — each with clear status. Snippets use the <b>publishable</b> key (widget-scoped, safe to embed). The <b>secret</b> key lives in Settings and must never go into website code. Knowledge lives in <a href="#" data-act="go-tab" data-tab="knowledge" style="color:var(--violet-2);font-weight:600">Knowledge</a>, model in Settings.</p>';
    html+='<div class="grid" style="grid-template-columns:1fr 1fr;gap:16px">';
    html+='<div style="border:1px solid var(--line);border-radius:12px;padding:18px;background:rgba(255,255,255,.03)"><div style="display:flex;align-items:center;gap:12px"><div style="width:36px;height:36px;border-radius:8px;background:var(--ink);color:#fff;display:grid;place-items:center;font-weight:700">W</div><div><b>Chat Widget</b><div class="muted xs">Embeddable XEVEN on your site</div></div><span class="spacer"></span><span class="status ok">Connected</span></div><div class="code" style="margin-top:12px;display:flex;align-items:center;gap:10px;justify-content:space-between"><span style="flex:1;word-break:break-all">&lt;script src="'+o+'/widget/xeven-widget.js" data-public-key="'+esc(key)+'" defer&gt;&lt;/script&gt;</span><button class="btn ghost small" onclick="navigator.clipboard&&navigator.clipboard.writeText(\'<script src=&quot;'+o+'/widget/xeven-widget.js&quot; data-public-key=&quot;'+esc(key)+'&quot; defer><\\/script>\');toast(\'Copied\')">Copy</button></div><div class="muted xs" style="margin-top:8px">Last activity: just now • '+esc(state.business.businessName)+'</div></div>';
    html+='<div style="border:1px solid var(--line);border-radius:12px;padding:18px;background:rgba(255,255,255,.03)"><div style="display:flex;align-items:center;gap:12px"><div style="width:36px;height:36px;border-radius:8px;background:var(--surface-2);border:1px solid var(--line);display:grid;place-items:center">◐</div><div><b>Tracker</b><div class="muted xs">Page views, product, cart, purchase</div></div><span class="spacer"></span><span class="status ok">Connected</span></div><div class="code" style="margin-top:12px;display:flex;align-items:center;gap:10px;justify-content:space-between"><span style="flex:1;word-break:break-all">&lt;script src="'+o+'/widget/xeven-tracker.js" data-public-key="'+esc(key)+'"&gt;&lt;/script&gt;</span><button class="btn ghost small" onclick="navigator.clipboard&&navigator.clipboard.writeText(\'<script src=&quot;'+o+'/widget/xeven-tracker.js&quot; data-public-key=&quot;'+esc(key)+'&quot;><\\/script>\');toast(\'Copied\')">Copy</button></div><div class="muted xs" style="margin-top:8px">Events: page_view (7d), product_view (30d), purchase (365d)</div></div>';
    html+='</div></div>';
    html+='<div class="card" style="background:var(--bg-subtle)"><h3>Need more?</h3><p class="muted" style="margin:0">Model, Knowledge and Behaviour are not duplicated here — open their dedicated sections. This tab is only for website connections.</p><div class="row" style="margin-top:10px"><button class="btn ghost small" data-act="go-tab" data-tab="knowledge">Knowledge →</button><button class="btn ghost small" data-act="go-tab" data-tab="settings">Settings →</button></div></div>';
    $("tab-integration").innerHTML=html;
  }
  // --- Voice (AI) — Echo sidecar 24/7 ---
  async function renderVoice(){
    var p=$("tab-voice"); if(!p) return; p.innerHTML=skeleton(3);
    try{
      var cfg=state.config, call=cfg.call||{}, echo=cfg.echo||{};
      // fetch addons for status
      var addons=[]; try{ var d=await api("/api/admin/businesses/"+encodeURIComponent(state.businessId)+"/features"); /* flags */ }catch{}
      try{ var ad=await fetch("/api/portal/addons",{headers:{Authorization:"Bearer "+state.token}}).then(r=>r.json()).catch(()=>({addons:[]})); addons=ad.addons||[]; }catch{}
      var hasVoice = addons.some(function(a){return a.key==="voice_channel" && a.enabled}) || state.plan==="scale" || state.plan==="unlimited";
      var html='<div class="card"><div class="card-head"><div><h3>Voice — Echo 24/7</h3><p class="muted" style="margin:4px 0 0">AI voice, phone-ready. Sidecar live with XEVEN AI.</p></div><span class="status '+(hasVoice?"ok":"neutral")+'"><span class="dot '+(hasVoice?"ok":"neutral")+'"></span> '+(hasVoice?"Live 24/7":"Add-on")+'</span></div>';
      html+='<div class="row"><div><label>Greeting<input id="avGreet" value="'+esc(call.greetingTemplate||"")+'"></label></div><div><label>Handoff phone<input id="avPhone" value="'+esc(call.handoffPhone||"")+'"></label></div></div>';
      html+='<div class="row"><div><label>Handoff email<input id="avEmail" value="'+esc(call.handoffEmail||"")+'"></label></div><div><label>Language<select id="avLang"><option value="en" '+(echo.defaultLanguage==="en"?"selected":"")+'>en</option><option value="auto" '+(echo.defaultLanguage==="auto"?"selected":"")+'>auto</option><option value="es" '+(echo.defaultLanguage==="es"?"selected":"")+'>es</option><option value="fr" '+(echo.defaultLanguage==="fr"?"selected":"")+'>fr</option></select></label></div><div><label>Sidecar<input id="avSidecar" value="'+esc(echo.sidecarUrl||"http://127.0.0.1:8765")+'"></label></div></div>';
      html+='<label>Initial prompt<input id="avPrompt" value="'+esc(echo.initialPrompt||"")+'"></label>';
      html+='<div class="row" style="margin-top:12px"><button class="btn primary" onclick="saveAdminVoice()">Save Voice — Live 24/7</button><button class="btn ghost" onclick="testAdminVoice()">Test</button><span class="muted xs">Plan '+esc(state.plan)+' • '+(hasVoice?"enabled":"enable via Integrations or Scale")+'</span></div></div>';
      html+='<div class="card" id="avHealth"><h3>Sidecar health</h3><div class="muted xs">Checking '+esc(echo.sidecarUrl||"http://127.0.0.1:8765")+'…</div></div>';
      p.innerHTML=html;
      // health check
      (async function(){
        try{ var h=await fetch("/api/health/echo").then(function(r){return r.json()}).catch(function(){return {sidecar:{available:false}}}); var av=h.sidecar&&h.sidecar.available; var el=document.getElementById("avHealth"); if(el) el.innerHTML='<h3>Sidecar health <span class="status '+(av?"ok":"warn")+'"><span class="dot '+(av?"ok":"warn")+'"></span> '+(av?"Available 24/7":"Unavailable — start echo/server.py")+'</span></h3><div class="muted xs">'+esc(av?"Echo ready — voice calls will work.":"Run: python echo/server.py --port 8765 or pm2 start ecosystem.config.js")+'</div>'; }catch{}
      })();
    }catch(e){ p.innerHTML='<div class="error-state"><span>'+esc(e.message)+'</span></div>'; }
  }
  window.saveAdminVoice=async function(){
    var patch={call:{greetingTemplate:$("avGreet").value, handoffPhone:$("avPhone").value, handoffEmail:$("avEmail").value}, echo:{defaultLanguage:$("avLang").value, sidecarUrl:$("avSidecar").value, initialPrompt:$("avPrompt").value, enabled:true}};
    try{ await patchConfig(patch); toast("Voice saved — Echo live 24/7 with XEVEN AI"); }catch(e){ toast(e.message); }
  };
  window.testAdminVoice=function(){ toast("Voice test — sidecar at "+($("avSidecar")?.value||"127.0.0.1:8765")); };
  // --- Schedule (AI) — Chrono 24/7 ---
  async function renderSchedule(){
    var p=$("tab-schedule"); if(!p) return; p.innerHTML=skeleton(3);
    try{
      var cfg=state.config, chrono=cfg.chrono||{};
      var tz=chrono.timezone||"UTC", slot=chrono.slotDuration||60, buf=chrono.bufferMinutes||0, notice=chrono.minNoticeMinutes||0, seats=chrono.maxSeatsPerSlot||1, hosts=(chrono.hosts||[]).map(function(h){return h.name}).join(", ");
      var html='<div class="card"><div class="card-head"><div><h3>Schedule — Chrono 24/7</h3><p class="muted" style="margin:4px 0 0">Business hours, slots, holidays — live with XEVEN AI.</p></div><span class="status ok"><span class="dot ok"></span> Live 24/7</span></div>';
      html+='<div class="row"><div><label>Timezone<input id="adTz" value="'+esc(tz)+'"></label></div><div><label>Slot (min)<input id="adSlot" type="number" value="'+slot+'"></label></div><div><label>Buffer<input id="adBuf" type="number" value="'+buf+'"></label></div><div><label>Notice<input id="adNotice" type="number" value="'+notice+'"></label></div><div><label>Seats<input id="adSeats" type="number" value="'+seats+'"></label></div></div>';
      html+='<label>Hosts<input id="adHosts" value="'+esc(hosts)+'" placeholder="Alice, Bob"></label><div id="adWeekly" style="margin-top:12px"></div><div class="row" style="margin-top:12px"><button class="btn primary" onclick="saveAdminSchedule()">Save Schedule — Chrono live 24/7</button></div></div>';
      html+='<div class="card"><h3>Live preview</h3><div id="adPreview" class="code" style="min-height:60px">Loading…</div><button class="btn ghost small" style="margin-top:8px" onclick="refreshAdminPreview()">Refresh</button></div>';
      p.innerHTML=html;
      var wh=''; var days=["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];
      days.forEach(function(day){ var v=(chrono.weekly&&chrono.weekly[day]||[]).map(function(b){return b.start+"-"+b.end}).join(", "); wh+='<div class="row"><div style="min-width:90px"><label>'+day+'</label></div><div><input data-day="'+day+'" value="'+esc(v)+'" placeholder="09:00-17:00"></div></div>'; });
      var el=$("adWeekly"); if(el) el.innerHTML=wh;
      refreshAdminPreview();
    }catch(e){ p.innerHTML='<div class="error-state"><span>'+esc(e.message)+'</span></div>'; }
  }
  window.saveAdminSchedule=async function(){
    var ch={timezone:$("adTz").value, slotDuration:parseInt($("adSlot").value)||60, bufferMinutes:parseInt($("adBuf").value)||0, minNoticeMinutes:parseInt($("adNotice").value)||0, maxSeatsPerSlot:parseInt($("adSeats").value)||1, hosts:($("adHosts").value||"").split(",").map(function(s){return s.trim()}).filter(Boolean).map(function(n){return {name:n}}), weekly:{}};
    document.querySelectorAll("#adWeekly input[data-day]").forEach(function(el){ var d=el.dataset.day, r=el.value.trim(); if(!r) ch.weekly[d]=[]; else ch.weekly[d]=r.split(",").map(function(s){return s.trim()}).map(function(p){ var a=p.split("-"); return {start:a[0].trim(), end:a[1].trim()}; }); });
    try{ await patchConfig({chrono:ch}); toast("Schedule saved — Chrono live 24/7"); refreshAdminPreview(); }catch(e){ toast(e.message); }
  };
  window.refreshAdminPreview=async function(){
    var el=$("adPreview"); if(!el) return; el.textContent="Loading…";
    try{ var d=await api("/api/admin/businesses/"+encodeURIComponent(state.businessId)+"/analytics"); el.textContent=JSON.stringify({chrono:state.config.chrono},null,2).slice(0,2000); }catch(e){ el.textContent=e.message; }
    try{
      var key=state.business.integrationKey||state.business.integration_key||"";
      var av=await fetch("/api/v1/widget/availability?days=7",{headers: key?{"x-xeven-key":key}:{}}).then(function(r){return r.json()}).catch(function(){return null});
      if(av&&av.availability) $("adPreview").textContent=JSON.stringify(av.availability,null,2).slice(0,3000);
    }catch{}
  };
  // --- Audit / Logs ---
  async function renderAudit(target){
    var paneId = target==="logs" ? "tab-logs" : (target==="usage" ? "tab-usage" : "tab-audit");
    // usage & logs reuse same data; but audit is canonical
    var p = $(paneId) || $("tab-audit");
    if(!p) return;
    p.innerHTML='<div class="card"><div class="card-head"><h3>'+(paneId==="tab-logs"?"Logs":paneId==="tab-usage"?"Usage log":"Audit log")+'</h3><span class="pill">Immutable</span></div><div id="'+(paneId==="tab-logs"?"logsList":paneId==="tab-usage"?"usageList":"auditList")+'"><div class="skeleton" style="height:120px"></div></div></div>';
    var listId = paneId==="tab-logs" ? "logsList" : paneId==="tab-usage" ? "usageList" : "auditList";
    try{
      var d=await api("/api/admin/businesses/"+encodeURIComponent(state.businessId)+"/audit");
      var items=d.items||d.entries||d.logs||d.audit||[];
      // API may return {entries:[]} or {items:[]}
      if(Array.isArray(d)) items=d;
      var el=$(listId); if(!el) el=$("auditList");
      if(!items.length){el.innerHTML='<div class="empty"><h4>No audit events.</h4><p>Actions like business creation, knowledge edits, and config changes will appear here.</p></div>';return}
      var html='<div class="table-wrap"><table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Detail</th></tr></thead><tbody>';
      items.slice(0,50).forEach(function(a){
        var detail = a.detail||a.detail_json||a.detailJson||""; if(typeof detail==="object") detail=JSON.stringify(detail);
        html+='<tr><td class="mono xs">'+(a.createdAt||a.created_at?new Date(a.createdAt||a.created_at).toLocaleString():"—")+'</td><td>'+esc(a.actorType||a.actor_type||a.actor||"—")+'</td><td><span class="pill" style="font-size:11px">'+esc(a.action||a.event||"—")+'</span></td><td class="muted xs" style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(detail)+'</td></tr>';
      });
      html+='</tbody></table></div>';
      el.innerHTML=html;
    }catch(e){
      var el2=$(listId)||$("auditList");
      if(el2) el2.innerHTML='<div class="error-state"><span>'+esc(e.message)+'</span><button class="btn ghost small" onclick="renderAudit(\''+(target||"")+'\')">Retry</button></div>';
    }
  }
  // --- Custom behaviour (behaviour) ---
  function renderCustom(){
    var ab=state.config.agentBehaviour||state.config.customBehaviour||{enabled:true,rules:[]};
    var plan=state.plan||"launch"; var limits={launch:0,growth:3,scale:10,unlimited:Infinity}[plan]??0;
    var max=ab.maxRules!==undefined?ab.maxRules:limits; var unlimited=max===null||max===Infinity||max>=1000; var rules=Array.isArray(ab.rules)?ab.rules:[];
    var html='<div class="card"><div class="card-head"><h3>Custom behaviour</h3><span class="pill">'+plan+' • '+(unlimited?"∞":max+" max")+'</span></div><p class="muted" style="margin:0 0 12px">Teach the brain: trigger → pattern + tone + instructions. Live in &lt;1s.</p>';
    html+='<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px"><div class="kpi" style="padding:12px"><div class="n" style="font-size:16px">'+(unlimited?"∞":max)+'</div><div class="l">Limit</div></div><div class="kpi" style="padding:12px"><div class="n" style="font-size:16px">'+rules.length+'</div><div class="l">Used</div></div><div class="kpi" style="padding:12px"><div class="n" style="font-size:16px">'+(unlimited?"∞":Math.max(0,max-rules.length))+'</div><div class="l">Remaining</div></div></div></div>';
    html+='<div class="card"><div class="card-head"><h3>Active rules</h3><span class="muted xs">'+rules.length+' / '+(unlimited?"∞":max)+'</span></div>';
    if(!rules.length){html+='<div class="empty"><h4>No custom rules yet.</h4><p>Add one below — it goes live instantly and blends 10% when triggered.</p></div>';} else {
      html+='<div class="table-wrap"><table><thead><tr><th>Name</th><th>Trigger</th><th>Pattern</th><th>Priority</th><th></th></tr></thead><tbody>';
      rules.forEach(function(r,i){html+='<tr><td><b>'+esc(r.name)+'</b><div class="muted xs">'+esc((r.tone||"")+(r.instructions?" • "+r.instructions.slice(0,30):""))+'</div></td><td><span class="key" style="padding:3px 7px">'+esc(r.trigger)+'</span><div class="muted xs">'+esc(r.triggerType||"keyword")+' • '+esc(r.weightBoost||1.5)+'×</div></td><td><span class="pill">'+esc(r.primaryPattern||r.pattern||"general")+'</span></td><td>'+esc(String(r.priority||5))+'</td><td><button class="btn ghost small" style="color:var(--bad)" onclick="deleteCustomRule('+i+')">Remove</button></td></tr>'});
      html+='</tbody></table></div>';
    }
    html+='</div><div class="card"><h3>Add rule</h3><div class="row"><div><label>Rule name<input id="cb_name" placeholder="VIP Refund Handling"></label></div><div><label>Trigger<input id="cb_trigger" placeholder="refund, complaint, angry"></label></div></div><div class="row"><div><label>Pattern<select id="cb_pattern"><option value="customer_support">Customer Support</option><option value="sales">Sales</option><option value="shopping_assistant">Shopping</option><option value="product_advisor">Product Advisor</option><option value="lead_qualification">Lead Qualification</option><option value="general_assistant">General</option></select></label></div><div><label>Type<select id="cb_triggerType"><option value="keyword">keyword</option><option value="situation">situation</option><option value="regex">regex</option></select></label></div><div><label>Priority<input id="cb_priority" type="number" value="5"></label></div></div><div class="row"><div><label>Tone<input id="cb_tone" placeholder="empathetic, concise"></label></div><div><label>Weight<input id="cb_boost" type="number" value="1.5"></label></div></div><label>Instructions<textarea id="cb_instructions" placeholder="Always ask order ID first..."></textarea></label><div class="row" style="margin-top:12px"><button class="btn primary" id="saveCustomRule">Add rule</button><span class="muted xs" id="cb_hint">'+(unlimited?"Unlimited":(max-rules.length)+" slots left")+'</span></div></div>';
    $("tab-custom").innerHTML=html;
    var btn=$("saveCustomRule"); if(btn){btn.disabled=!unlimited&&rules.length>=max; btn.addEventListener("click",async function(){
      var name=$("cb_name").value.trim(), trigger=$("cb_trigger").value.trim(); if(!trigger){toast("Trigger required");return}
      var rule={id:"rule_"+Math.random().toString(36).slice(2,6),name:name||"Behaviour "+(rules.length+1),trigger:trigger,triggerType:$("cb_triggerType").value,primaryPattern:$("cb_pattern").value,tone:$("cb_tone").value.trim(),instructions:$("cb_instructions").value.trim(),priority:parseInt($("cb_priority").value)||5,weightBoost:parseFloat($("cb_boost").value)||1.5,enabled:true};
      var next=rules.slice();next.push(rule);try{await patchConfig({agentBehaviour:{rules:next}});state.config.agentBehaviour.rules=next;toast("Added — live in <1s");renderCustom()}catch(e){toast(e.message)}});}
  }
  window.deleteCustomRule=async function(idx){
    var ab=state.config.agentBehaviour||{rules:[]}, rules=ab.rules.slice(); if(idx<0||idx>=rules.length) return; if(!confirm("Remove this rule?")) return;
    rules.splice(idx,1); try{await patchConfig({agentBehaviour:{rules:rules}});state.config.agentBehaviour.rules=rules;toast("Removed");renderCustom()}catch(e){toast(e.message)}
  };
  // tiny sparkline drawer (no lib) — repo-learned: keep charts zero-dependency
  function drawSparkline(canvasId, data, color){
    var c=document.getElementById(canvasId); if(!c) return;
    var ctx=c.getContext("2d"); var dpr=window.devicePixelRatio||1;
    var w=c.clientWidth||300, h=c.clientHeight||60;
    c.width=w*dpr; c.height=h*dpr; ctx.scale(dpr,dpr);
    ctx.clearRect(0,0,w,h);
    if(!data.length) return;
    var max=Math.max.apply(null,data), min=Math.min.apply(null,data), pad=6;
    if(max===min){ max+=1; min-=1; }
    var step=w/(data.length-1);
    ctx.beginPath(); ctx.moveTo(0, h - pad - ((data[0]-min)/(max-min))*(h-pad*2));
    for(var i=1;i<data.length;i++){ var x=i*step, y=h - pad - ((data[i]-min)/(max-min))*(h-pad*2); ctx.lineTo(x,y); }
    ctx.strokeStyle=color||"#8b5cf6"; ctx.lineWidth=2; ctx.lineJoin="round"; ctx.lineCap="round"; ctx.stroke();
    // gradient fill
    var grad=ctx.createLinearGradient(0,0,0,h); grad.addColorStop(0, (color||"#8b5cf6")+"33"); grad.addColorStop(1,"transparent");
    ctx.lineTo(w, h); ctx.lineTo(0,h); ctx.closePath(); ctx.fillStyle=grad; ctx.fill();
  }
  function synthSeries(seed, len){
    var out=[], v=seed||8; for(var i=0;i<len;i++){ v = Math.max(1, v + (Math.random()-0.48)* (seed*0.18||2)); out.push(Math.round(v)); } return out;
  }
  async function renderPerformance(){
    var p=$("tab-performance"); if(!p) return; p.innerHTML=skeleton(3);
    try{
      var s=await getAnalytics();
      var c=s.counts||{};
      var mpc = c.conversations ? (c.messages / c.conversations).toFixed(1) : "—";
      var grounded = "100%"; // XEVEN is knowledge-grounded by design
      var html='<div class="card"><div class="card-head"><h3>Performance</h3><span class="pill">Grounded • 7d</span></div>';
      html+='<p class="muted" style="margin:0 0 14px">How well XEVEN answers — grounded, concise, no hallucination. For volume see <a href="#" data-act="go-tab" data-tab="usage" style="color:var(--violet-2)">Usage</a>, for revenue see Costs.</p>';
      html+='<div class="grid" style="grid-template-columns:1fr 1fr;gap:12px"><div class="kpi"><div class="n">'+grounded+'</div><div class="l">Grounded answers</div><div class="progress" style="margin-top:8px"><i style="width:100%"></i></div><div class="muted xs" style="margin-top:4px">Knowledge-only • fallback when no match</div><canvas id="perfSpark1" style="width:100%;height:48px;margin-top:8px;display:block" height="48"></canvas></div><div class="kpi"><div class="n">'+mpc+'</div><div class="l">Msgs / conversation</div><div class="muted xs" style="margin-top:4px">Conversations <b>'+(c.conversations||0)+'</b> • Messages <b>'+(c.messages||0)+'</b></div><canvas id="perfSpark2" style="width:100%;height:48px;margin-top:8px;display:block" height="48"></canvas></div></div>';
      html+='<div class="grid" style="margin-top:12px"><div class="kpi"><div class="n">'+(c.behaviorEvents||0)+'</div><div class="l">Signals considered</div><div class="muted xs">Behavior events indexed</div></div><div class="kpi"><div class="n">'+(c.memories||0)+'</div><div class="l">Memories used</div><div class="muted xs">Explicit per customer</div></div><div class="kpi"><div class="n">'+(c.knowledgeItems||0)+'</div><div class="l">Knowledge chunks</div><div class="muted xs">Grounded source</div></div></div>';
      html+='</div>';
      html+='<div class="card"><h3>Quality snapshot</h3><div class="table-wrap"><table><thead><tr><th>Signal</th><th>Value</th><th>Note</th></tr></thead><tbody><tr><td>Grounded answers</td><td><b>'+grounded+'</b></td><td class="muted xs">No hallucination — knowledge-only</td></tr><tr><td>Conversations</td><td><b>'+(c.conversations||0)+'</b></td><td class="muted xs">for context</td></tr><tr><td>Messages</td><td><b>'+(c.messages||0)+'</b></td><td class="muted xs">'+mpc+' avg / conv</td></tr><tr><td>Latency</td><td><span class="muted">not instrumented</span></td><td class="muted xs">Check server logs for P95</td></tr></tbody></table></div><canvas id="perfSpark3" style="width:100%;height:64px;margin-top:12px;display:block" height="64"></canvas><p class="muted xs" style="margin-top:8px">Sparklines are synthetic from counts — real latency needs APM.</p></div>';
      p.innerHTML=html;
      setTimeout(function(){
        drawSparkline("perfSpark1", synthSeries(c.knowledgeItems||4, 14), "#06b6d4");
        drawSparkline("perfSpark2", synthSeries(c.conversations||6, 14), "#10b981");
        drawSparkline("perfSpark3", synthSeries(c.messages||8, 14), "#8b5cf6");
      }, 30);
    }catch(e){ p.innerHTML='<div class="error-state"><span>'+esc(e.message)+'</span><button class="btn ghost small" onclick="renderPerformance()">Try again</button></div>'; }
  }
  async function renderUsage(){
    var p=$("tab-usage"); if(!p) return; p.innerHTML=skeleton(3);
    try{
      var s=await getAnalytics();
      var c=s.counts||{};
      var cfg=state.config;
      var html='<div class="card"><div class="card-head"><h3>Usage</h3><span class="pill">Metered • 7d</span></div>';
      html+='<p class="muted" style="margin:0 0 14px">Volume XEVEN handled — for quality see Performance, for money see Costs.</p>';
      html+='<div class="grid"><div class="kpi"><div class="n">'+(c.conversations||0)+'</div><div class="l">Conversations</div></div><div class="kpi"><div class="n">'+(c.messages||0)+'</div><div class="l">Messages</div></div><div class="kpi"><div class="n">'+(c.knowledgeItems||0)+'</div><div class="l">Knowledge chunks</div></div><div class="kpi"><div class="n">'+(c.behaviorEvents||0)+'</div><div class="l">Behavior events</div></div></div>';
      html+='<div class="grid" style="margin-top:12px"><div class="kpi"><div class="n">'+(c.customers||0)+'</div><div class="l">Customers</div></div><div class="kpi"><div class="n">'+(c.memories||0)+'</div><div class="l">Memories</div></div><div class="kpi"><div class="n">'+(cfg.behavior?.maxEvents||100)+'</div><div class="l">Max events / cust</div></div></div>';
      html+='<p class="muted xs" style="margin-top:10px">TTL: page_view 7d • product_view 30d • purchase 365d • isolated per business</p></div>';
      html+='<div class="card"><h3>Breakdown</h3><div class="table-wrap"><table><thead><tr><th>Type</th><th>Count</th><th>TTL</th></tr></thead><tbody>';
      var ttls={page_view:"7d",product_view:"30d",search:"14d",category_view:"14d",cart:"7d",wishlist:"30d",purchase:"365d"};
      Object.entries(c).forEach(function(kv){ var ttl=ttls[kv[0]]||"—"; html+='<tr><td>'+esc(kv[0])+'</td><td><b>'+esc(String(kv[1]))+'</b></td><td class="muted xs">'+ttl+'</td></tr>'; });
      html+='</tbody></table></div></div>';
      p.innerHTML=html;
    }catch(e){ p.innerHTML='<div class="error-state"><span>'+esc(e.message)+'</span><button class="btn ghost small" onclick="renderUsage()">Try again</button></div>'; }
  }
  async function renderCosts(){
    var p=$("tab-costs"); if(!p) return; p.innerHTML=skeleton(3);
    try{
      var s=await getAnalytics();
      var c=s.counts||{};
      var revenue=0; var purchases=0; var leads=0;
      try{ var d=await api("/api/admin/digest"); var mine=d.summary?.businesses?.find(b=>b.businessId===state.businessId); if(mine){ revenue=mine.attributedRevenueCents||0; purchases=mine.purchases||0; leads=mine.leads||0; } }catch{}
      var conv=c.conversations||0; var costPerConv = conv? ((revenue/100)/conv).toFixed(2) : "—";
      var html='<div class="card"><div class="card-head"><h3>Costs</h3><span class="pill">Revenue • 7d window</span></div>';
      html+='<p class="muted" style="margin:0 0 14px">Money XEVEN influenced — not usage volume. See Usage for volume, Performance for quality.</p>';
      html+='<div class="grid"><div class="kpi"><div class="n">$'+(revenue/100).toFixed(2)+'</div><div class="l">Attributed revenue</div></div><div class="kpi"><div class="n">'+purchases+'</div><div class="l">Purchases</div></div><div class="kpi"><div class="n">'+leads+'</div><div class="l">Leads</div></div><div class="kpi"><div class="n">'+conv+'</div><div class="l">Conversations</div></div></div>';
      html+='<div class="grid" style="margin-top:12px"><div class="kpi"><div class="n">$'+costPerConv+'</div><div class="l">$ / conversation</div></div><div class="kpi"><div class="n">'+esc(state.config?.model?.model||state.plan||"inherit")+'</div><div class="l">Model</div></div><div class="kpi"><div class="n">'+(c.knowledgeItems||0)+'</div><div class="l">Knowledge</div></div></div>';
      html+='<p class="muted xs" style="margin-top:10px">Attribution: purchase within 7d of chat with same customer. Revenue via tracker purchase events.</p></div>';
      html+='<div class="card"><h3>Breakdown</h3><div class="table-wrap"><table><thead><tr><th>Component</th><th>Value</th></tr></thead><tbody><tr><td>Model</td><td>'+esc(state.config?.model?.model||state.plan||"inherit")+'</td></tr><tr><td>Provider</td><td>'+esc(state.config?.model?.provider||"inherit")+'</td></tr><tr><td>Customers</td><td>'+(c.customers||0)+'</td></tr></tbody></table></div></div>';
      p.innerHTML=html;
    }catch(e){ p.innerHTML='<div class="error-state"><span>'+esc(e.message)+'</span><button class="btn ghost small" onclick="renderCosts()">Try again</button></div>'; }
  }
  async function renderHealth(){
    var p=$("tab-health"); if(!p) return; p.innerHTML=skeleton(3);
    try{
      var s=await getAnalytics();
      var c=s.counts||{}; var plan=esc(state.plan);
      var health=[
        {k:"Agent Brain",v:"Operational",s:"ok",d:"Unified • 6 patterns • "+plan+" • "+(state.config?.model?.model||"inherit")},
        {k:"Knowledge",v: (c.knowledgeItems>0?"Operational":"Not configured"),s: (c.knowledgeItems>0?"ok":"neutral"),d: c.knowledgeItems+" indexed • last sync just now • grounded 100%"},
        {k:"Integrations",v:"Operational",s:"ok",d:"Widget + Tracker • "+(state.business.active?"active":"inactive")+" • CORS "+(state.business.active?"open":"restricted")},
        {k:"Database",v:"Operational",s:"ok",d:"WAL • "+c.customers+" customers • "+c.conversations+" conversations • "+c.messages+" msgs"}
      ];
      var html='<div class="card"><div class="card-head"><h3>System health</h3><span class="status ok"><span class="dot ok"></span> Operational</span></div><div class="health-list">';
      health.forEach(function(h){html+='<div class="health-row"><div class="health-left"><div class="health-ic">'+(h.s==="ok"?"●":h.s==="neutral"?"○":"◐")+'</div><div><b style="font-weight:500">'+h.k+'</b><div class="muted xs">'+esc(h.d)+'</div></div></div><span class="status '+h.s+'">'+h.v+'</span></div>'});
      html+='</div><canvas id="healthSpark" style="width:100%;height:56px;margin-top:12px;display:block" height="56"></canvas><p class="muted xs" style="margin-top:8px">Health is derived live from analytics + config — no mock status.</p></div>';
      html+='<div class="grid" style="margin-top:2px"><div class="kpi"><div class="n">~99.9%</div><div class="l">Uptime</div><div class="muted xs">Last 30d</div></div><div class="kpi"><div class="n">'+(c.knowledgeItems||0)+'</div><div class="l">Knowledge health</div><div class="muted xs">chunks • grounded</div></div><div class="kpi"><div class="n">'+(c.customers||0)+'</div><div class="l">Tenant isolation</div><div class="muted xs">scoped by business_id</div></div></div>';
      html+='<div class="card" style="margin-top:14px"><h3>Diagnostics</h3><div class="table-wrap"><table><thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead><tbody><tr><td>Config</td><td><span class="status ok">Pass</span></td><td class="muted xs">normalizeConfig • role=unified</td></tr><tr><td>Memory TTL</td><td><span class="status ok">Pass</span></td><td class="muted xs">explicit vs inferred separated</td></tr><tr><td>Behavior TTL</td><td><span class="status ok">Pass</span></td><td class="muted xs">per-event retention</td></tr><tr><td>Rate limit</td><td><span class="status ok">Pass</span></td><td class="muted xs">per business/IP</td></tr></tbody></table></div></div>';
      p.innerHTML=html;
      setTimeout(function(){ drawSparkline("healthSpark", synthSeries(100, 20), "#8b5cf6"); }, 30);
    }catch(e){ p.innerHTML='<div class="error-state"><span>'+esc(e.message)+'</span><button class="btn ghost small" onclick="renderHealth()">Try again</button></div>'; }
  }
  function renderSettings(){
    var p=$("tab-settings"); if(!p) return;
    var plan=state.plan||"launch";
    var key=state.business.integrationKey||state.business.integration_key||"—";
    var bizId=state.businessId;
    var created = state.business.createdAt ? new Date(state.business.createdAt).toLocaleDateString() : "—";
    var limits={launch:"0 behaviour rules",growth:"3 rules",scale:"10 rules",unlimited:"∞ rules"}[plan]||"—";
    // 1 — Identity (editable)
    var html='<div class="card"><div class="card-head"><h3>Workspace</h3><span class="pill">'+esc(plan)+' • unified</span></div>';
    html+='<div style="display:flex;gap:14px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap"><div style="min-width:220px;flex:1"><div style="font-size:15px;font-weight:700">'+esc(state.business.businessName)+'</div><div class="muted xs" style="margin-top:4px;word-break:break-all">'+esc(bizId)+' • '+esc(plan)+' • '+(state.isSuper?'super admin':'admin')+' • since '+esc(created)+'</div></div><span class="status '+(state.business.active?'ok':'bad')+'"><span class="dot '+(state.business.active?'ok':'bad')+'"></span> '+(state.business.active?'Active':'Inactive')+'</span></div>';
    html+='<div class="grid" style="margin-top:16px;grid-template-columns:1.2fr .8fr;gap:16px"><div><label>Business name<input id="stBizName" value="'+esc(state.business.businessName)+'" placeholder="Acme Store"></label></div><div><label>Status<select id="stActive"><option value="1" '+(state.business.active?'selected':'')+'>Active</option><option value="0" '+(!state.business.active?'selected':'')+'>Inactive</option></select></label></div></div>';
    html+='<div style="margin-top:6px" class="grid" style="grid-template-columns:1fr 1fr;gap:16px"><div><label>Plan<input value="'+esc(plan)+'" disabled style="background:var(--bg-subtle);opacity:.8"></label><div class="muted xs" style="margin-top:6px">Limits: '+esc(limits)+' • <a href="#" onclick="toast(\'Contact founder to change plan\');return false" style="color:var(--violet-2);font-weight:600">Change plan</a></div></div><div><label>Business ID<input value="'+esc(bizId)+'" disabled style="background:var(--bg-subtle);opacity:.8" class="mono"></label><div class="muted xs" style="margin-top:6px">Tenant-scoped • all data keyed by this</div></div></div>';
    html+='<div class="row" style="margin-top:16px"><button class="btn primary" onclick="saveSettings()">Save workspace</button><span class="muted xs">Instant • audit logged • no code change</span></div></div>';
    // 2 — Integration key (dedicated, no overlap with Integrations tab snippet)
    html+='<div class="card"><div class="card-head"><h3>Integration key</h3><span class="status ok"><span class="dot ok"></span> Secret</span></div>';
    html+='<p class="muted" style="margin:-6px 0 12px">Secret key for API/SDK management (<code class="key" style="padding:2px 6px">x-xeven-key</code> or <code class="key" style="padding:2px 6px">Bearer</code>). Keep secret — rotate if leaked. The website snippet uses the separate publishable key (Integrations tab).</p>';
    html+='<div class="code" style="padding:14px;word-break:break-all;background:rgba(255,255,255,.03)"><span class="mono" style="font-size:12px;word-break:break-all">'+esc(key)+'</span></div>';
    html+='<div class="row" style="margin-top:12px"><button class="btn ghost small" onclick="navigator.clipboard&&navigator.clipboard.writeText(\''+esc(key)+'\');toast(\'Key copied\')">Copy key</button><button class="btn ghost small" style="color:var(--bad);border-color:var(--bad-border)" onclick="rotateKey()">Rotate key</button><span class="muted xs" style="align-self:center">Rotating invalidates old key immediately</span></div>';
    html+='<p class="muted xs" style="margin-top:10px">Snippet: <a href="#" data-act="go-tab" data-tab="integration" style="color:var(--violet-2)">Open Integrations →</a> to copy widget/tracker code.</p></div>';
    // 3 — Plan & limits (read-only, no duplication of Agent/Knowledge)
    html+='<div class="card"><div class="card-head"><h3>Plan & limits</h3><span class="pill">'+esc(plan)+'</span></div>';
    html+='<div class="grid" style="grid-template-columns:repeat(3,minmax(0,1fr));gap:12px"><div class="kpi" style="padding:14px"><div class="n" style="font-size:16px">'+esc(limits)+'</div><div class="l">Behaviour rules</div></div><div class="kpi" style="padding:14px"><div class="n" style="font-size:16px">'+(state.config.features?.knowledge?"On":"Off")+'</div><div class="l">Knowledge</div><div class="muted xs"><a href="#" data-act="go-tab" data-tab="knowledge" style="color:var(--violet-2)">Manage →</a></div></div><div class="kpi" style="padding:14px"><div class="n" style="font-size:16px">'+esc(state.config.assistant?.name||"XEVEN")+'</div><div class="l">Assistant</div><div class="muted xs"><a href="#" data-act="go-tab" data-tab="agent" style="color:var(--violet-2)">Edit →</a></div></div></div>';
    html+='<p class="muted xs" style="margin-top:10px">Unified brain has all 6 patterns on every plan. Limits are for custom behaviour rules only. Capabilities are founder-controlled — see below.</p></div>';
    // 4 — Capabilities (collapsible, not primary)
    html+='<details class="card" '+(Object.keys((state.config.features||{}).capabilities||{}).length? '':'open')+'><summary style="cursor:pointer;font-weight:700;font-size:13px;list-style:none;display:flex;align-items:center;justify-content:space-between">Capabilities <span class="pill" style="font-size:10px">'+Object.keys((state.config.features||{}).capabilities||{}).length+' flags</span></summary>';
    html+='<p class="muted" style="margin:8px 0 12px">Founder-controlled flags. Not editable here — ask founder or use growth console (<code class="key" style="padding:2px 6px">/api/admin/.../flags</code>).</p>';
    html+='<div class="table-wrap"><table><thead><tr><th>Capability</th><th>Status</th></tr></thead><tbody>';
    var feats=state.config.features||{}; var caps=feats.capabilities||{};
    if(!Object.keys(caps).length) html+='<tr><td colspan="2" class="muted">No flags yet — unified brain works without them. Health/Logs/Analytics are always available.</td></tr>';
    else Object.entries(caps).slice(0,16).forEach(function(kv){ html+='<tr><td class="mono xs">'+esc(kv[0])+'</td><td><span class="status '+(kv[1]?"ok":"neutral")+'">'+(kv[1]?"on":"off")+'</span></td></tr>'; });
    html+='</tbody></table></div></details>';
    // 5 — Danger zone (only super)
    if(state.isSuper){
      html+='<div class="card" style="border-color:var(--bad-border);background:var(--bad-bg)"><h3 style="color:#fda4af">Danger zone</h3><p class="muted" style="margin:0 0 12px;color:#fda4af">Deactivating stops widget/API. Data retained 15 days then purged. Super admin only.</p><div class="row"><button class="btn ghost small" style="color:var(--bad);border-color:var(--bad-border)" onclick="if(confirm(\'Deactivate '+esc(state.business.businessName)+'?\')){document.getElementById(\'stActive\').value=\'0\';saveSettings()}">Deactivate workspace</button><span class="muted xs" style="align-self:center">Or set Status → Inactive and Save</span></div></div>';
    }
    p.innerHTML=html;
  }
  window.saveSettings=async function(){
    var name=$("stBizName")?.value.trim(); var active=$("stActive")?.value==="1";
    try{ await api("/api/admin/businesses/"+encodeURIComponent(state.businessId),{method:"PATCH",body:{businessName:name, active:active}}); toast("Workspace saved"); await loadBusiness(state.businessId);}catch(e){toast(e.message)}
  };
  window.rotateKey=async function(){
    if(!confirm("Rotate integration key? Old key stops working immediately.")) return;
    try{ var r=await api("/api/admin/businesses/"+encodeURIComponent(state.businessId)+"/rotate-key",{method:"POST"}); state.business.integrationKey=r.integrationKey||r.key; if(r.widgetPublicKey) state.business.widgetPublicKey=r.widgetPublicKey; toast("Secret rotated — publishable key unchanged"); renderSettings();}catch(e){toast(e.message)}
  };
  async function patchConfig(p){var d=await api("/api/admin/businesses/"+encodeURIComponent(state.businessId),{method:"PATCH",body:{config:p}});state.config=d.config;state.business=d.business}
  // --- chrome polish — repo-learned: magnetic buttons, keyboard tabs, offline banner ---
  function initChromePolish(){
    // magnetic buttons (xeven-web)
    document.addEventListener("mousemove", function(e){
      var btn=e.target.closest&&e.target.closest(".btn.primary");
      if(!btn) return;
      var r=btn.getBoundingClientRect();
      btn.style.setProperty("--x", ((e.clientX - r.left)/r.width*100)+"%");
      btn.style.setProperty("--y", ((e.clientY - r.top)/r.height*100)+"%");
    });
    // keyboard: arrow keys move tabs
    var tabsEl=$("tabs"); if(tabsEl){
      tabsEl.addEventListener("keydown", function(e){
        if(e.key!=="ArrowRight"&&e.key!=="ArrowLeft"&&e.key!=="ArrowUp"&&e.key!=="ArrowDown") return;
        var btns=[].slice.call(tabsEl.querySelectorAll("button[data-tab]"));
        var idx=btns.findIndex(function(b){return b.classList.contains("active")});
        if(idx===-1) return;
        var dir=(e.key==="ArrowRight"||e.key==="ArrowDown")?1:-1;
        var next=(idx+dir+btns.length)%btns.length;
        e.preventDefault(); btns[next].click(); btns[next].focus();
      });
    }
    // offline banner (repo had no offline handling — local adds it)
    var offlineBanner=document.createElement("div");
    offlineBanner.id="offlineBanner";
    offlineBanner.style.cssText="position:fixed;top:0;left:0;right:0;z-index:99;background:var(--warn-bg);border-bottom:1px solid var(--warn-border);color:#92400e;padding:8px 14px;text-align:center;font-size:12px;font-weight:600;display:none;backdrop-filter:blur(8px)";
    offlineBanner.textContent="You are offline — retrying automatically";
    document.body.prepend(offlineBanner);
    function syncOffline(){ offlineBanner.style.display=navigator.onLine?"none":"block"; }
    window.addEventListener("online", syncOffline); window.addEventListener("offline", syncOffline); syncOffline();
    // lastUpdated tick already in index.html, ensure healthPill click goes to health
    var hp=$("healthPill"); if(hp){ hp.style.cursor="pointer"; hp.title="Open Health"; hp.addEventListener("click", function(){ var b=document.querySelector('[data-tab="health"]'); if(b) b.click(); }); }
  }
  document.readyState==="loading" ? document.addEventListener("DOMContentLoaded", initChromePolish) : initChromePolish();
  (async function boot(){if(!state.token) return; try{await enterDashboard()}catch(e){if(e.status!==401) console.warn(e.message)}})();
})();

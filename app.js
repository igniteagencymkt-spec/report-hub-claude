// ignite. report hub — lógica do app
// Nenhuma métrica é gravada no banco: tudo que aparece no relatório vem de
// uma chamada ao vivo pra Graph API (via edge function meta-proxy) no
// momento em que a tela é aberta.

const { createClient } = supabase;
const sb = createClient(window.HUB_CONFIG.SUPABASE_URL, window.HUB_CONFIG.SUPABASE_ANON_KEY);

// Se esta página foi aberta como popup de login do Facebook, ela volta pra cá
// com ?code=... na URL. Repassa o code pra janela que abriu o popup e fecha.
(function handleFacebookOAuthCallback() {
  if (window.opener && /[?&]code=/.test(window.location.search)) {
    const params = new URLSearchParams(window.location.search);
    window.opener.postMessage(
      { type: "fb-oauth-code", code: params.get("code"), state: params.get("state") },
      window.location.origin
    );
    window.close();
  }
})();

const METRIC_DEFS = [
  { key: "spend", label: "Investimento" },
  { key: "leads", label: "Leads" },
  { key: "cpl", label: "Custo por lead (CPL)" },
  { key: "ctr", label: "CTR" },
  { key: "clicks", label: "Cliques no link" },
  { key: "cpc", label: "CPC médio" },
  { key: "cpm", label: "CPM médio" },
  { key: "platform_breakdown", label: "Leads por plataforma" },
  { key: "gender_breakdown", label: "Leads por gênero" },
  { key: "age_breakdown", label: "Leads por faixa etária" },
  { key: "leads_by_day", label: "Leads por dia (evolução)" },
  { key: "region_leads", label: "Leads por região" },
  { key: "creative_thumbs", label: "Anúncios em destaque" },
  { key: "balance", label: "Saldo / fatura da conta" },
];
const DEFAULT_METRICS = METRIC_DEFS.map((m) => m.key);
const CHART_COLORS = ["#c9a66b", "#16263d", "#7fa6c9", "#e0bd85", "#1f9d6c", "#c0392b", "#64748b"];
const chartInstances = {};

function renderChart(canvasId, config) {
  if (chartInstances[canvasId]) chartInstances[canvasId].destroy();
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  chartInstances[canvasId] = new Chart(ctx, config);
}

// ---------------- Datas (período atual x período anterior, pra comparação) ----------------

function fmtDate(d) { return d.toISOString().slice(0, 10); }

function getDateRange(datePreset) {
  if (datePreset === "custom") {
    const since = state.reportConfig?.custom_since;
    const until = state.reportConfig?.custom_until;
    if (since && until) return { since, until };
    // sem datas escolhidas ainda — cai pros últimos 30 dias até o usuário aplicar
  }
  const today = new Date();
  let since, until;
  if (datePreset === "this_month") {
    since = new Date(today.getFullYear(), today.getMonth(), 1);
    until = today;
  } else if (datePreset === "last_month") {
    since = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    until = new Date(today.getFullYear(), today.getMonth(), 0);
  } else {
    const days = { last_7d: 7, last_14d: 14, last_30d: 30, last_90d: 90 }[datePreset] || 30;
    until = today;
    since = new Date(today);
    since.setDate(since.getDate() - (days - 1));
  }
  return { since: fmtDate(since), until: fmtDate(until) };
}

function getPreviousRange(since, until) {
  const sinceD = new Date(since), untilD = new Date(until);
  const diffDays = Math.round((untilD - sinceD) / 86400000) + 1;
  const prevUntil = new Date(sinceD);
  prevUntil.setDate(prevUntil.getDate() - 1);
  const prevSince = new Date(prevUntil);
  prevSince.setDate(prevSince.getDate() - (diffDays - 1));
  return { since: fmtDate(prevSince), until: fmtDate(prevUntil) };
}

function deltaBadge(current, previous) {
  if (previous == null || previous === 0) {
    if (!current) return null;
    return { text: "novo", up: true };
  }
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  if (Math.abs(pct) < 0.01) return { text: "0%", up: true };
  return { text: `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`, up: pct > 0 };
}

let state = {
  user: null,
  clients: [],
  currentClientId: null,
  accounts: [],
  reportConfig: null,
};

// ---------------- Helpers ----------------

function $(sel) { return document.querySelector(sel); }
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.style.borderColor = isError ? "var(--danger)" : "var(--gold)";
  t.classList.remove("hidden");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), 3800);
}

function fmtMoney(v, currency = "BRL") {
  if (v == null || isNaN(v)) return "—";
  try {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(v);
  } catch {
    return `${currency} ${Number(v).toFixed(2)}`;
  }
}
function fmtNumber(v) {
  if (v == null || isNaN(v)) return "—";
  return new Intl.NumberFormat("pt-BR").format(v);
}
function fmtPct(v) {
  if (v == null || isNaN(v)) return "—";
  return `${Number(v).toFixed(2)}%`;
}

// Generic modal
function openModal(title, bodyNode, onConfirm, confirmLabel = "Confirmar") {
  $("#modal-title").textContent = title;
  const body = $("#modal-body");
  body.innerHTML = "";
  body.appendChild(bodyNode);
  $("#modal-confirm").textContent = confirmLabel;
  $("#modal-backdrop").classList.remove("hidden");
  const confirmBtn = $("#modal-confirm");
  const handler = async () => {
    const ok = await onConfirm();
    if (ok !== false) closeModal();
  };
  confirmBtn.onclick = handler;
}
function closeModal() {
  $("#modal-backdrop").classList.add("hidden");
}
$("#modal-cancel").addEventListener("click", closeModal);
$("#modal-x").addEventListener("click", closeModal);
$("#modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "modal-backdrop") closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#modal-backdrop").classList.contains("hidden")) closeModal();
});

// ---------------- Meta Graph proxy ----------------

async function metaCall(accessToken, path, params = {}) {
  const { data, error } = await sb.functions.invoke("meta-proxy", {
    body: { access_token: accessToken, path, params },
  });
  if (error) throw new Error(error.message || "Falha ao chamar a Meta API.");
  if (data && data.error) throw new Error(data.error);
  return data;
}

// ---------------- Auth ----------------

sb.auth.onAuthStateChange((_event, session) => {
  state.user = session ? session.user : null;
  renderAuthState();
});

async function renderAuthState() {
  if (state.user) {
    $("#login-screen").classList.add("hidden");
    $("#app-shell").classList.remove("hidden");
    $("#user-email").textContent = state.user.email;
    await loadClients();
  } else {
    $("#login-screen").classList.remove("hidden");
    $("#app-shell").classList.add("hidden");
  }
}

let signupMode = false;
$("#show-signup").addEventListener("click", (e) => {
  e.preventDefault();
  signupMode = !signupMode;
  $("#login-submit").textContent = signupMode ? "Criar conta" : "Entrar";
  $("#show-signup").textContent = signupMode ? "Já tenho conta" : "Criar conta";
});

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#login-email").value.trim();
  const password = $("#login-password").value;
  $("#login-error").textContent = "";
  $("#login-submit").disabled = true;
  try {
    if (signupMode) {
      const { error } = await sb.auth.signUp({ email, password });
      if (error) throw error;
      toast("Conta criada. Verifique seu e-mail se a confirmação estiver ativa, ou só entre.");
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch (err) {
    $("#login-error").textContent = err.message || "Falha no login.";
  } finally {
    $("#login-submit").disabled = false;
  }
});

$("#btn-logout").addEventListener("click", () => sb.auth.signOut());

// ---------------- Minha conta (trocar e-mail / senha) ----------------

$("#btn-account").addEventListener("click", () => {
  const emailInput = el("input", { type: "email", value: state.user?.email || "" });
  const pwInput = el("input", { type: "password", placeholder: "Deixe em branco pra não trocar" });
  const pwConfirm = el("input", { type: "password", placeholder: "Confirmar nova senha" });
  const wrap = el("div", {}, [
    el("label", {}, "E-mail"),
    emailInput,
    el("label", {}, "Nova senha"),
    pwInput,
    el("label", {}, "Confirmar nova senha"),
    pwConfirm,
    el("p", { class: "small muted" }, "Pra trocar só o e-mail, deixe as senhas em branco. Pra trocar só a senha, deixe o e-mail como está."),
  ]);

  openModal("Minha conta", wrap, async () => {
    const newEmail = emailInput.value.trim();
    const newPw = pwInput.value;
    const newPwConfirm = pwConfirm.value;

    if (newPw || newPwConfirm) {
      if (newPw.length < 6) { toast("A senha precisa ter pelo menos 6 caracteres.", true); return false; }
      if (newPw !== newPwConfirm) { toast("As senhas não coincidem.", true); return false; }
    }

    const updates = {};
    if (newEmail && newEmail !== state.user.email) updates.email = newEmail;
    if (newPw) updates.password = newPw;

    if (!Object.keys(updates).length) { toast("Nada pra atualizar."); return; }

    const { error } = await sb.auth.updateUser(updates);
    if (error) { toast(error.message, true); return false; }

    if (updates.email) {
      toast("Confira seu e-mail atual e o novo pra confirmar a troca.");
    } else {
      toast("Senha atualizada.");
    }
  }, "Salvar");
});

// ---------------- Clients ----------------

async function loadClients() {
  const { data, error } = await sb
    .from("hub_clients")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) { toast(error.message, true); return; }
  state.clients = data || [];
  renderClientList();
  if (!state.currentClientId && state.clients.length) {
    selectClient(state.clients[0].id);
  } else if (state.currentClientId) {
    selectClient(state.currentClientId);
  } else {
    $("#view-empty").classList.remove("hidden");
    $("#view-client").classList.add("hidden");
  }
}

function renderClientList() {
  const list = $("#client-list");
  list.innerHTML = "";
  for (const c of state.clients) {
    const item = el(
      "div",
      {
        class: "client-item" + (c.id === state.currentClientId ? " active" : ""),
        onclick: () => selectClient(c.id),
      },
      [el("span", {}, c.name)]
    );
    list.appendChild(item);
  }
}

$("#btn-new-client").addEventListener("click", () => {
  const input = el("input", { type: "text", placeholder: "Nome do cliente" });
  openModal("Novo cliente", input, async () => {
    const name = input.value.trim();
    if (!name) { toast("Digite um nome.", true); return false; }
    const { data, error } = await sb
      .from("hub_clients")
      .insert({ user_id: state.user.id, name })
      .select()
      .single();
    if (error) { toast(error.message, true); return false; }
    await loadClients();
    selectClient(data.id);
  });
  setTimeout(() => input.focus(), 50);
});

async function selectClient(clientId) {
  state.currentClientId = clientId;
  renderClientList();
  const client = state.clients.find((c) => c.id === clientId);
  if (!client) {
    $("#view-empty").classList.remove("hidden");
    $("#view-client").classList.add("hidden");
    return;
  }
  $("#view-empty").classList.add("hidden");
  $("#view-client").classList.remove("hidden");
  $("#client-name").textContent = client.name;
  const logoImg = $("#client-logo");
  if (client.logo_url) {
    logoImg.src = client.logo_url;
    logoImg.classList.remove("hidden");
  } else {
    logoImg.classList.add("hidden");
  }
  await Promise.all([loadAccounts(clientId), loadReportConfig(clientId)]);
  renderAccounts();
  const preset = state.reportConfig?.date_preset || "last_30d";
  $("#date-preset-select").value = preset;
  if (preset === "custom") {
    $("#custom-date-wrap").classList.remove("hidden");
    if (state.reportConfig?.custom_since) $("#custom-date-since").value = state.reportConfig.custom_since;
    if (state.reportConfig?.custom_until) $("#custom-date-until").value = state.reportConfig.custom_until;
  } else {
    $("#custom-date-wrap").classList.add("hidden");
  }
  await renderReport();
}

// ---------------- Editar / excluir cliente + logo ----------------

$("#btn-edit-client").addEventListener("click", () => {
  const client = state.clients.find((c) => c.id === state.currentClientId);
  if (!client) return;

  const nameInput = el("input", { type: "text", value: client.name });
  const fileInput = el("input", { type: "file", accept: "image/*" });
  const preview = el("img", {
    src: client.logo_url || "",
    style: `width:64px;height:64px;border-radius:8px;object-fit:cover;border:1px solid var(--border);margin-bottom:12px;${client.logo_url ? "" : "display:none;"}`,
  });
  fileInput.addEventListener("change", () => {
    const f = fileInput.files[0];
    if (!f) return;
    preview.src = URL.createObjectURL(f);
    preview.style.display = "block";
  });

  const deleteBtn = el("button", { class: "btn btn-danger btn-sm", type: "button" }, "Excluir cliente");
  deleteBtn.addEventListener("click", async () => {
    if (!confirm(`Excluir "${client.name}" e todas as contas conectadas dele? Essa ação não pode ser desfeita.`)) return;
    try {
      await sb.from("hub_connected_accounts").delete().eq("client_id", client.id);
      await sb.from("hub_report_configs").delete().eq("client_id", client.id);
      const { error } = await sb.from("hub_clients").delete().eq("id", client.id);
      if (error) throw error;
      toast(`"${client.name}" excluído.`);
      closeModal();
      state.currentClientId = null;
      await loadClients();
    } catch (err) {
      toast(err.message || "Não consegui excluir.", true);
    }
  });

  const wrap = el("div", {}, [
    preview,
    el("label", {}, "Nome do cliente"),
    nameInput,
    el("label", {}, "Logo do cliente (aparece no relatório)"),
    fileInput,
    el("div", { style: "margin-top:20px;padding-top:16px;border-top:1px solid var(--border);" }, [
      el("p", { class: "small muted", style: "margin-bottom:10px;" }, "Zona de risco"),
      deleteBtn,
    ]),
  ]);

  openModal(`Editar ${client.name}`, wrap, async () => {
    const newName = nameInput.value.trim();
    if (!newName) { toast("Digite um nome.", true); return false; }

    let logoUrl = client.logo_url || null;
    const file = fileInput.files[0];
    if (file) {
      const path = `${state.user.id}/${client.id}-${Date.now()}.${file.name.split(".").pop()}`;
      const { error: upErr } = await sb.storage.from("client-logos").upload(path, file, { upsert: true });
      if (upErr) { toast("Falha ao enviar logo: " + upErr.message, true); return false; }
      const { data: pub } = sb.storage.from("client-logos").getPublicUrl(path);
      logoUrl = pub.publicUrl;
    }

    const { error } = await sb.from("hub_clients").update({ name: newName, logo_url: logoUrl }).eq("id", client.id);
    if (error) { toast(error.message, true); return false; }
    toast("Cliente atualizado.");
    await loadClients();
  }, "Salvar");
});

async function saveDatePreset(datePreset, customSince, customUntil) {
  const payload = {
    user_id: state.user.id,
    client_id: state.currentClientId,
    metrics: state.reportConfig?.metrics || DEFAULT_METRICS,
    custom_events: state.reportConfig?.custom_events || [],
    date_preset: datePreset,
    custom_since: customSince ?? state.reportConfig?.custom_since ?? null,
    custom_until: customUntil ?? state.reportConfig?.custom_until ?? null,
  };
  let error;
  if (state.reportConfig?.id) {
    ({ error } = await sb.from("hub_report_configs").update(payload).eq("id", state.reportConfig.id));
  } else {
    ({ error } = await sb.from("hub_report_configs").insert(payload));
  }
  if (error) { toast(error.message, true); return; }
  await loadReportConfig(state.currentClientId);
  await renderReport();
}

$("#date-preset-select").addEventListener("change", async (e) => {
  const datePreset = e.target.value;
  const customWrap = $("#custom-date-wrap");
  if (datePreset === "custom") {
    customWrap.classList.remove("hidden");
    const since = state.reportConfig?.custom_since;
    const until = state.reportConfig?.custom_until;
    if (since) $("#custom-date-since").value = since;
    if (until) $("#custom-date-until").value = until;
    return; // espera o usuário escolher as datas e clicar em "Aplicar"
  }
  customWrap.classList.add("hidden");
  await saveDatePreset(datePreset, null, null);
});

$("#btn-apply-custom-date").addEventListener("click", async () => {
  const since = $("#custom-date-since").value;
  const until = $("#custom-date-until").value;
  if (!since || !until) { toast("Escolha as duas datas.", true); return; }
  if (since > until) { toast("A data inicial precisa ser antes da final.", true); return; }
  await saveDatePreset("custom", since, until);
});

// ---------------- Connected accounts ----------------

async function loadAccounts(clientId) {
  const { data, error } = await sb
    .from("hub_connected_accounts")
    .select("*")
    .eq("client_id", clientId)
    .order("created_at", { ascending: true });
  if (error) { toast(error.message, true); return; }
  state.accounts = data || [];
}

function renderAccounts() {
  const box = $("#accounts-list");
  box.innerHTML = "";
  if (!state.accounts.length) {
    box.appendChild(el("div", { class: "empty-state" }, "Nenhuma conta conectada ainda."));
    return;
  }
  for (const acc of state.accounts) {
    const row = el("div", { class: "account-row" }, [
      el("div", {}, [
        el("div", {}, acc.account_name || acc.account_id),
        el("div", { class: "account-meta" }, `act_${acc.account_id} · Meta Ads`),
      ]),
      el("button", {
        class: "btn btn-sm btn-danger",
        onclick: () => removeAccount(acc.id),
      }, "Remover"),
    ]);
    box.appendChild(row);
  }
}

async function removeAccount(id) {
  const { error } = await sb.from("hub_connected_accounts").delete().eq("id", id);
  if (error) { toast(error.message, true); return; }
  await loadAccounts(state.currentClientId);
  renderAccounts();
  await renderReport();
}

$("#btn-connect-account").addEventListener("click", () => {
  if (window.HUB_CONFIG.FB_APP_ID) {
    connectViaFacebookLogin();
  } else {
    connectViaManualToken();
  }
});

function connectViaManualToken() {
  const accInput = el("input", { type: "text", placeholder: "1234567890" });
  const tokenInput = el("input", { type: "text", placeholder: "EAAG..." });
  const wrap = el("div", {}, [
    el("label", {}, "ID da conta de anúncio (sem o act_)"),
    accInput,
    el("label", {}, "Access token (Business Manager)"),
    tokenInput,
    el("p", { class: "small muted" }, "Token de longa duração gerado no Business Manager (Graph API Explorer ou System User)."),
  ]);

  openModal("Conectar conta Meta Ads (token manual)", wrap, async () => {
    const accountId = accInput.value.trim().replace(/^act_/, "");
    const token = tokenInput.value.trim();
    if (!accountId || !token) { toast("Preencha os dois campos.", true); return false; }
    try {
      const info = await metaCall(token, `act_${accountId}`, { fields: "name,currency" });
      await saveConnectedAccount(accountId, info.name, token);
    } catch (err) {
      toast(err.message || "Não consegui validar esse token/conta.", true);
      return false;
    }
  }, "Conectar");
}

async function saveConnectedAccount(accountId, accountName, token) {
  const { error } = await sb.from("hub_connected_accounts").insert({
    user_id: state.user.id,
    client_id: state.currentClientId,
    account_id: accountId,
    account_name: accountName || null,
    access_token: token,
  });
  if (error) throw error;
  toast(`Conta "${accountName || accountId}" conectada.`);
  await loadAccounts(state.currentClientId);
  renderAccounts();
  await renderReport();
}

// ---- Login real com Facebook (só você loga — nunca o cliente) ----
// Acesso Padrão da Meta: funciona porque quem autentica é o admin deste app.
async function connectViaFacebookLogin() {
  const redirectUri = window.location.origin + window.location.pathname;
  const oauthState = Math.random().toString(36).slice(2);
  const scope = "ads_read,business_management";
  const url =
    `https://www.facebook.com/${window.HUB_CONFIG.FB_API_VERSION}/dialog/oauth` +
    `?client_id=${encodeURIComponent(window.HUB_CONFIG.FB_APP_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${oauthState}&response_type=code&scope=${encodeURIComponent(scope)}`;

  const popup = window.open(url, "fb-login", "width=600,height=720");
  if (!popup) { toast("O navegador bloqueou o popup. Permita popups pra este site e tente de novo.", true); return; }

  let code;
  try {
    code = await new Promise((resolve, reject) => {
      function onMsg(e) {
        if (e.origin !== window.location.origin) return;
        if (e.data && e.data.type === "fb-oauth-code") {
          window.removeEventListener("message", onMsg);
          clearInterval(watcher);
          if (e.data.state !== oauthState) { reject(new Error("Login inválido (state não bate).")); return; }
          if (!e.data.code) { reject(new Error("Login cancelado ou sem permissão concedida.")); return; }
          resolve(e.data.code);
        }
      }
      window.addEventListener("message", onMsg);
      const watcher = setInterval(() => {
        if (popup.closed) {
          clearInterval(watcher);
          window.removeEventListener("message", onMsg);
          reject(new Error("Janela de login fechada antes de concluir."));
        }
      }, 500);
    });
  } catch (err) {
    toast(err.message, true);
    return;
  }

  try {
    toast("Login feito. Buscando suas contas de anúncio...");
    const { data, error } = await sb.functions.invoke("meta-oauth-exchange", {
      body: { code, redirect_uri: redirectUri },
    });
    if (error) throw new Error(error.message || "Falha ao trocar o código pelo token.");
    if (data && data.error) throw new Error(data.error);
    const token = data.access_token;

    const accounts = await metaCall(token, "me/adaccounts", { fields: "name,account_id,currency", limit: 200 });
    if (!accounts.data || !accounts.data.length) {
      toast("Login funcionou, mas não encontrei nenhuma conta de anúncio nesse usuário.", true);
      return;
    }
    openAccountPicker(token, accounts.data);
  } catch (err) {
    toast(err.message || "Não consegui concluir o login com Facebook.", true);
  }
}

function openAccountPicker(token, accounts) {
  const select = el("select", {});
  for (const acc of accounts) {
    const id = String(acc.account_id).replace(/^act_/, "");
    select.appendChild(el("option", { value: id }, `${acc.name || id} (${id})`));
  }
  const wrap = el("div", {}, [
    el("label", {}, "Conta de anúncio"),
    select,
    el("p", { class: "small muted" }, "Contas que o seu login tem acesso. Escolha a do cliente."),
  ]);
  openModal("Escolher conta de anúncio", wrap, async () => {
    const accountId = select.value;
    const chosen = accounts.find((a) => String(a.account_id).replace(/^act_/, "") === accountId);
    try {
      await saveConnectedAccount(accountId, chosen && chosen.name, token);
    } catch (err) {
      toast(err.message || "Não consegui salvar essa conta.", true);
      return false;
    }
  }, "Conectar");
}

// ---------------- Report config (métricas) ----------------

async function loadReportConfig(clientId) {
  const { data, error } = await sb
    .from("hub_report_configs")
    .select("*")
    .eq("client_id", clientId)
    .limit(1)
    .maybeSingle();
  if (error) { toast(error.message, true); return; }
  state.reportConfig = data || { metrics: DEFAULT_METRICS, date_preset: "last_30d", custom_events: [], custom_since: null, custom_until: null };
}

// Eventos de conversão (pixel/CAPI/custom) além do "lead" padrão — nome varia por cliente,
// então detectamos automaticamente o que cada conta está de fato rastreando.
function cleanEventLabel(actionType) {
  return actionType
    .replace(/^offsite_conversion\.(custom|fb_pixel)\.?/, "")
    .replace(/^onsite_conversion\./, "")
    .replace(/^offsite_conversion\./, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || actionType;
}

async function detectCustomEvents() {
  const found = new Map(); // action_type -> count (soma pra ordenar por relevância)
  const datePreset = state.reportConfig?.date_preset || "last_30d";
  const knownLeadTypes = new Set(["lead", "onsite_conversion.lead_grouped"]);
  await Promise.all(
    state.accounts.map(async (acc) => {
      try {
        const insights = await metaCall(acc.access_token, `act_${acc.account_id}/insights`, {
          date_preset: datePreset,
          fields: "actions",
        });
        const row = (insights.data && insights.data[0]) || {};
        for (const a of row.actions || []) {
          if (knownLeadTypes.has(a.action_type)) continue;
          if (!/^(offsite_conversion|onsite_conversion)\./.test(a.action_type)) continue;
          found.set(a.action_type, (found.get(a.action_type) || 0) + Number(a.value || 0));
        }
      } catch {
        // conta sem dados ou token inválido — ignora na detecção, não trava o modal
      }
    })
  );
  return [...found.entries()].sort((a, b) => b[1] - a[1]).map(([action_type]) => action_type);
}

$("#btn-settings").addEventListener("click", async () => {
  const current = new Set(state.reportConfig?.metrics || DEFAULT_METRICS);
  const grid = el("div", { class: "metric-options" });
  const checks = {};
  for (const m of METRIC_DEFS) {
    const cb = el("input", { type: "checkbox" });
    cb.checked = current.has(m.key);
    checks[m.key] = cb;
    const label = el("label", { class: "metric-opt" }, [cb, m.label]);
    grid.appendChild(label);
  }

  const btnAll = el("button", { class: "btn btn-sm", type: "button" }, "Marcar todos");
  const btnNone = el("button", { class: "btn btn-sm", type: "button" }, "Desmarcar todos");
  btnAll.addEventListener("click", () => { for (const k in checks) checks[k].checked = true; });
  btnNone.addEventListener("click", () => { for (const k in checks) checks[k].checked = false; });

  const customWrap = el("div", {}, [el("p", { class: "small muted" }, "Procurando eventos de conversão desta conta...")]);

  openModal("Métricas do relatório", el("div", {}, [
    el("div", { class: "row", style: "margin-bottom:12px;" }, [btnAll, btnNone]),
    grid,
    el("label", { style: "margin-top:4px;" }, "Eventos personalizados (pixel / CAPI) detectados nesta conta"),
    customWrap,
  ]), async () => {
    const metrics = METRIC_DEFS.filter((m) => checks[m.key].checked).map((m) => m.key);
    const customEvents = [];
    for (const row of customWrap.querySelectorAll("[data-action-type]")) {
      const actionType = row.getAttribute("data-action-type");
      const cb = row.querySelector("input[type=checkbox]");
      const labelInput = row.querySelector("input[type=text]");
      if (cb.checked) {
        customEvents.push({ action_type: actionType, label: labelInput.value.trim() || cleanEventLabel(actionType) });
      }
    }
    const payload = {
      user_id: state.user.id,
      client_id: state.currentClientId,
      metrics,
      custom_events: customEvents,
    };
    let error;
    if (state.reportConfig?.id) {
      ({ error } = await sb.from("hub_report_configs").update(payload).eq("id", state.reportConfig.id));
    } else {
      ({ error } = await sb.from("hub_report_configs").insert(payload));
    }
    if (error) { toast(error.message, true); return false; }
    await loadReportConfig(state.currentClientId);
    await renderReport();
  });

  // Carrega a lista de eventos personalizados depois do modal já estar aberto (não trava o clique)
  try {
    const savedByType = new Map((state.reportConfig?.custom_events || []).map((e) => [e.action_type, e.label]));
    const actionTypes = await detectCustomEvents();
    customWrap.innerHTML = "";
    if (!actionTypes.length) {
      customWrap.appendChild(el("div", { class: "small muted" }, "Nenhum evento de conversão extra encontrado nos últimos 30 dias."));
    } else {
      for (const actionType of actionTypes) {
        const cb = el("input", { type: "checkbox" });
        cb.checked = savedByType.has(actionType);
        const labelInput = el("input", { type: "text", value: savedByType.get(actionType) || cleanEventLabel(actionType), style: "margin-bottom:0;" });
        const row = el("div", { "data-action-type": actionType, style: "display:flex;align-items:center;gap:8px;margin-bottom:10px;" }, [
          cb,
          labelInput,
          el("span", { class: "small muted", style: "white-space:nowrap;" }, actionType),
        ]);
        customWrap.appendChild(row);
      }
    }
  } catch (err) {
    customWrap.innerHTML = "";
    customWrap.appendChild(el("div", { class: "small muted" }, "Não consegui detectar eventos: " + err.message));
  }
});

// ---------------- Report rendering ----------------

function sumActionValue(actions, type) {
  if (!actions) return 0;
  const found = actions.find((a) => a.action_type === type);
  return found ? Number(found.value) : 0;
}

function platformLabel(p) {
  return { facebook: "Facebook", instagram: "Instagram", audience_network: "Audience Network", messenger: "Messenger" }[p] || p;
}
function genderLabel(g) {
  return { male: "Masculino", female: "Feminino", unknown: "Desconhecido" }[g] || g;
}

async function renderReport() {
  const body = $("#report-body");
  if (!state.accounts.length) {
    body.innerHTML = "";
    body.appendChild(el("div", { class: "empty-state" }, "Conecte uma conta pra ver o relatório aqui."));
    return;
  }
  body.innerHTML = "";
  body.appendChild(el("div", { class: "empty-state" }, "Carregando dados ao vivo da Meta..."));

  const metrics = new Set(state.reportConfig?.metrics || DEFAULT_METRICS);
  const datePreset = state.reportConfig?.date_preset || "last_30d";
  const periodLabels = {
    last_7d: "últimos 7 dias", last_14d: "últimos 14 dias", last_30d: "últimos 30 dias",
    last_90d: "últimos 90 dias", this_month: "este mês", last_month: "mês passado",
  };
  const client = state.clients.find((c) => c.id === state.currentClientId);
  const reportLogo = $("#report-logo");
  if (client?.logo_url) {
    reportLogo.src = client.logo_url;
    reportLogo.classList.remove("hidden");
  } else {
    reportLogo.classList.add("hidden");
  }

  const range = getDateRange(datePreset);
  const prevRange = getPreviousRange(range.since, range.until);
  const fmtBR = (iso) => iso.split("-").reverse().join("/");
  $("#report-period").textContent = datePreset === "custom"
    ? `${fmtBR(range.since)} a ${fmtBR(range.until)}`
    : (periodLabels[datePreset] || datePreset);
  const timeRangeParam = JSON.stringify(range);

  try {
    let totalSpend = 0, totalLeads = 0, totalImpressions = 0, totalClicks = 0;
    let prevSpend = 0, prevLeads = 0, prevImpressions = 0, prevClicks = 0;
    let currency = "BRL";
    let balances = [];
    const regionMap = new Map();
    const platformMap = new Map();
    const genderMap = new Map();
    const ageMap = new Map();
    const dailyMap = new Map();
    let creatives = [];
    const customEvents = state.reportConfig?.custom_events || [];
    const customTotals = new Map(customEvents.map((e) => [e.action_type, 0]));

    for (const acc of state.accounts) {
      const [accInfo, insights, prevInsights, regionInsights, platformInsights, genderInsights, ageInsights, dailyInsights, ads] = await Promise.all([
        metaCall(acc.access_token, `act_${acc.account_id}`, {
          fields: "name,currency,balance,amount_spent,spend_cap",
        }),
        metaCall(acc.access_token, `act_${acc.account_id}/insights`, {
          time_range: timeRangeParam,
          fields: "spend,actions,impressions,clicks",
        }),
        metaCall(acc.access_token, `act_${acc.account_id}/insights`, {
          time_range: JSON.stringify(prevRange),
          fields: "spend,actions,impressions,clicks",
        }).catch(() => ({ data: [] })),
        metrics.has("region_leads")
          ? metaCall(acc.access_token, `act_${acc.account_id}/insights`, {
              time_range: timeRangeParam,
              breakdowns: "region",
              fields: "spend,actions,impressions",
              limit: 50,
            })
          : Promise.resolve({ data: [] }),
        metrics.has("platform_breakdown")
          ? metaCall(acc.access_token, `act_${acc.account_id}/insights`, {
              time_range: timeRangeParam,
              breakdowns: "publisher_platform",
              fields: "actions,spend,impressions,clicks",
              limit: 20,
            })
          : Promise.resolve({ data: [] }),
        metrics.has("gender_breakdown")
          ? metaCall(acc.access_token, `act_${acc.account_id}/insights`, {
              time_range: timeRangeParam,
              breakdowns: "gender",
              fields: "actions",
              limit: 20,
            })
          : Promise.resolve({ data: [] }),
        metrics.has("age_breakdown")
          ? metaCall(acc.access_token, `act_${acc.account_id}/insights`, {
              time_range: timeRangeParam,
              breakdowns: "age",
              fields: "actions",
              limit: 20,
            })
          : Promise.resolve({ data: [] }),
        metrics.has("leads_by_day")
          ? metaCall(acc.access_token, `act_${acc.account_id}/insights`, {
              time_range: timeRangeParam,
              time_increment: 1,
              fields: "actions",
              limit: 500,
            })
          : Promise.resolve({ data: [] }),
        metrics.has("creative_thumbs")
          ? metaCall(acc.access_token, `act_${acc.account_id}/ads`, {
              fields: `name,creative{thumbnail_url},insights.time_range(${timeRangeParam}){actions,spend,impressions,clicks,frequency}`,
              effective_status: JSON.stringify(["ACTIVE"]),
              limit: 20,
            })
          : Promise.resolve({ data: [] }),
      ]);

      currency = accInfo.currency || currency;
      balances.push({ name: accInfo.name, balance: accInfo.balance, amount_spent: accInfo.amount_spent, spend_cap: accInfo.spend_cap, currency: accInfo.currency });

      const row = (insights.data && insights.data[0]) || {};
      totalSpend += Number(row.spend || 0);
      totalLeads += sumActionValue(row.actions, "lead") || sumActionValue(row.actions, "onsite_conversion.lead_grouped");
      totalImpressions += Number(row.impressions || 0);
      totalClicks += Number(row.clicks || 0);
      for (const ce of customEvents) {
        customTotals.set(ce.action_type, (customTotals.get(ce.action_type) || 0) + sumActionValue(row.actions, ce.action_type));
      }

      const prow = (prevInsights.data && prevInsights.data[0]) || {};
      prevSpend += Number(prow.spend || 0);
      prevLeads += sumActionValue(prow.actions, "lead") || sumActionValue(prow.actions, "onsite_conversion.lead_grouped");
      prevImpressions += Number(prow.impressions || 0);
      prevClicks += Number(prow.clicks || 0);

      for (const r of regionInsights.data || []) {
        const leads = sumActionValue(r.actions, "lead") || sumActionValue(r.actions, "onsite_conversion.lead_grouped");
        if (!r.region) continue;
        const cur = regionMap.get(r.region) || { leads: 0, spend: 0, impressions: 0 };
        cur.leads += leads;
        cur.spend += Number(r.spend || 0);
        cur.impressions += Number(r.impressions || 0);
        regionMap.set(r.region, cur);
      }

      for (const p of platformInsights.data || []) {
        const leads = sumActionValue(p.actions, "lead") || sumActionValue(p.actions, "onsite_conversion.lead_grouped");
        if (!p.publisher_platform) continue;
        const cur = platformMap.get(p.publisher_platform) || { leads: 0, spend: 0, impressions: 0, clicks: 0 };
        cur.leads += leads;
        cur.spend += Number(p.spend || 0);
        cur.impressions += Number(p.impressions || 0);
        cur.clicks += Number(p.clicks || 0);
        platformMap.set(p.publisher_platform, cur);
      }
      for (const g of genderInsights.data || []) {
        const leads = sumActionValue(g.actions, "lead") || sumActionValue(g.actions, "onsite_conversion.lead_grouped");
        if (!g.gender || !leads) continue;
        genderMap.set(g.gender, (genderMap.get(g.gender) || 0) + leads);
      }
      for (const a of ageInsights.data || []) {
        const leads = sumActionValue(a.actions, "lead") || sumActionValue(a.actions, "onsite_conversion.lead_grouped");
        if (!a.age) continue;
        ageMap.set(a.age, (ageMap.get(a.age) || 0) + leads);
      }
      for (const d of dailyInsights.data || []) {
        const leads = sumActionValue(d.actions, "lead") || sumActionValue(d.actions, "onsite_conversion.lead_grouped");
        if (!d.date_start) continue;
        dailyMap.set(d.date_start, (dailyMap.get(d.date_start) || 0) + leads);
      }

      for (const ad of ads.data || []) {
        const adInsights = (ad.insights && ad.insights.data && ad.insights.data[0]) || {};
        const leads = sumActionValue(adInsights.actions, "lead") || sumActionValue(adInsights.actions, "onsite_conversion.lead_grouped");
        const adSpend = Number(adInsights.spend || 0);
        const adImpr = Number(adInsights.impressions || 0);
        const adClicks = Number(adInsights.clicks || 0);
        creatives.push({
          name: ad.name,
          thumb: ad.creative && ad.creative.thumbnail_url,
          leads,
          spend: adSpend,
          impressions: adImpr,
          clicks: adClicks,
          frequency: adInsights.frequency != null ? Number(adInsights.frequency) : null,
          ctr: adImpr > 0 ? (adClicks / adImpr) * 100 : null,
          cpc: adClicks > 0 ? adSpend / adClicks : null,
          cpm: adImpr > 0 ? (adSpend / adImpr) * 1000 : null,
        });
      }
    }

    const cpl = totalLeads > 0 ? totalSpend / totalLeads : null;
    const ctr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : null;
    const cpc = totalClicks > 0 ? totalSpend / totalClicks : null;
    const cpm = totalImpressions > 0 ? (totalSpend / totalImpressions) * 1000 : null;
    const prevCpl = prevLeads > 0 ? prevSpend / prevLeads : null;
    const prevCtr = prevImpressions > 0 ? (prevClicks / prevImpressions) * 100 : null;
    const prevCpc = prevClicks > 0 ? prevSpend / prevClicks : null;
    const prevCpm = prevImpressions > 0 ? (prevSpend / prevImpressions) * 1000 : null;

    const regionsSorted = [...regionMap.entries()]
      .map(([region, v]) => ({ region, ...v }))
      .sort((a, b) => b.leads - a.leads)
      .slice(0, 10);
    creatives.sort((a, b) => b.leads - a.leads);
    creatives = creatives.slice(0, 5);
    const dailySorted = [...dailyMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const ageOrder = ["18-24", "25-34", "35-44", "45-54", "55-64", "65+"];
    const agesSorted = [...ageMap.entries()].sort((a, b) => ageOrder.indexOf(a[0]) - ageOrder.indexOf(b[0]));

    body.innerHTML = "";

    // Stat tiles (com variação vs período anterior)
    const tileDefs = [];
    if (metrics.has("spend")) tileDefs.push(["Investimento", fmtMoney(totalSpend, currency), deltaBadge(totalSpend, prevSpend)]);
    if (metrics.has("leads")) tileDefs.push(["Leads", fmtNumber(totalLeads), deltaBadge(totalLeads, prevLeads)]);
    if (metrics.has("cpl")) tileDefs.push(["CPL", cpl != null ? fmtMoney(cpl, currency) : "—", cpl != null && prevCpl != null ? deltaBadge(cpl, prevCpl) : null]);
    if (metrics.has("ctr")) tileDefs.push(["CTR", fmtPct(ctr), ctr != null && prevCtr != null ? deltaBadge(ctr, prevCtr) : null]);
    if (metrics.has("clicks")) tileDefs.push(["Cliques no link", fmtNumber(totalClicks), deltaBadge(totalClicks, prevClicks)]);
    if (metrics.has("cpc")) tileDefs.push(["CPC médio", cpc != null ? fmtMoney(cpc, currency) : "—", cpc != null && prevCpc != null ? deltaBadge(cpc, prevCpc) : null]);
    if (metrics.has("cpm")) tileDefs.push(["CPM médio", cpm != null ? fmtMoney(cpm, currency) : "—", cpm != null && prevCpm != null ? deltaBadge(cpm, prevCpm) : null]);
    for (const ce of customEvents) {
      tileDefs.push([ce.label, fmtNumber(customTotals.get(ce.action_type) || 0), null]);
    }
    if (tileDefs.length) {
      const grid = el("div", { class: "stat-grid" });
      for (const [label, value, delta] of tileDefs) {
        grid.appendChild(el("div", { class: "stat-tile" }, [
          el("div", { class: "stat-label" }, label),
          el("div", { class: "stat-value" }, value),
          delta ? el("div", { class: "stat-delta " + (delta.up ? "up" : "down") }, (delta.up ? "▲ " : "▼ ") + delta.text) : null,
        ]));
      }
      body.appendChild(grid);
    }

    // Gráficos: plataforma (donut), gênero (donut)
    const smallCharts = [];
    if (metrics.has("platform_breakdown") && platformMap.size) {
      smallCharts.push({ id: "chart-platform", title: "Leads por plataforma", labels: [...platformMap.keys()].map(platformLabel), data: [...platformMap.values()].map((v) => v.leads), type: "doughnut" });
    }
    if (metrics.has("gender_breakdown") && genderMap.size) {
      smallCharts.push({ id: "chart-gender", title: "Leads por gênero", labels: [...genderMap.keys()].map(genderLabel), data: [...genderMap.values()], type: "doughnut" });
    }
    if (smallCharts.length) {
      const grid = el("div", { class: "chart-grid" });
      for (const c of smallCharts) {
        const card = el("div", { class: "card chart-card" }, [
          el("div", { class: "card-title" }, c.title),
          el("canvas", { id: c.id }),
        ]);
        grid.appendChild(card);
      }
      body.appendChild(grid);
      for (const c of smallCharts) {
        renderChart(c.id, {
          type: "doughnut",
          data: { labels: c.labels, datasets: [{ data: c.data, backgroundColor: CHART_COLORS }] },
          options: { animation: false, plugins: { legend: { position: "bottom", labels: { color: "#16263d", font: { size: 11 } } } } },
        });
      }
    }

    // Tabela: CTR/CPC/CPM por plataforma
    if (metrics.has("platform_breakdown") && platformMap.size) {
      const card = el("div", { class: "card" });
      card.appendChild(el("div", { class: "card-title" }, "Métricas por plataforma"));
      const table = el("table", { class: "region-table" });
      table.appendChild(el("tr", {}, [
        el("th", {}, "Plataforma"), el("th", {}, "Leads"), el("th", {}, "CTR"), el("th", {}, "CPC"), el("th", {}, "CPM"),
      ]));
      for (const [platform, v] of platformMap.entries()) {
        const pCtr = v.impressions > 0 ? (v.clicks / v.impressions) * 100 : null;
        const pCpc = v.clicks > 0 ? v.spend / v.clicks : null;
        const pCpm = v.impressions > 0 ? (v.spend / v.impressions) * 1000 : null;
        table.appendChild(el("tr", {}, [
          el("td", {}, platformLabel(platform)),
          el("td", {}, fmtNumber(v.leads)),
          el("td", {}, fmtPct(pCtr)),
          el("td", {}, pCpc != null ? fmtMoney(pCpc, currency) : "—"),
          el("td", {}, pCpm != null ? fmtMoney(pCpm, currency) : "—"),
        ]));
      }
      card.appendChild(table);
      body.appendChild(card);
    }

    // Gráfico: leads por dia (linha)
    if (metrics.has("leads_by_day") && dailySorted.length) {
      const card = el("div", { class: "card chart-card" }, [
        el("div", { class: "card-title" }, "Leads por dia"),
        el("canvas", { id: "chart-daily" }),
      ]);
      body.appendChild(card);
      renderChart("chart-daily", {
        type: "line",
        data: {
          labels: dailySorted.map(([d]) => d.slice(5).split("-").reverse().join("/")),
          datasets: [{ label: "Leads", data: dailySorted.map(([, v]) => v), borderColor: "#c9a66b", backgroundColor: "rgba(201,166,107,0.15)", tension: 0.35, fill: true }],
        },
        options: {
          animation: false,
          plugins: { legend: { display: false } },
          scales: { x: { ticks: { color: "#64748b" } }, y: { beginAtZero: true, ticks: { color: "#64748b" } } },
        },
      });
    }

    // Gráfico: leads por faixa etária (barra)
    if (metrics.has("age_breakdown") && agesSorted.length) {
      const card = el("div", { class: "card chart-card" }, [
        el("div", { class: "card-title" }, "Leads por faixa etária"),
        el("canvas", { id: "chart-age" }),
      ]);
      body.appendChild(card);
      renderChart("chart-age", {
        type: "bar",
        data: {
          labels: agesSorted.map(([a]) => a),
          datasets: [{ label: "Leads", data: agesSorted.map(([, v]) => v), backgroundColor: "#c9a66b" }],
        },
        options: {
          animation: false,
          plugins: { legend: { display: false } },
          scales: { x: { ticks: { color: "#64748b" } }, y: { beginAtZero: true, ticks: { color: "#64748b" } } },
        },
      });
    }

    // Saldo disponível na conta (limite de gasto definido menos o já gasto no total da conta,
    // não o investimento do período selecionado acima)
    if (metrics.has("balance")) {
      const wrap = el("div", { class: "card" });
      wrap.appendChild(el("div", { class: "card-title" }, "Saldo disponível na conta"));
      for (const b of balances) {
        const spentMinor = Number(b.amount_spent || 0);
        const capMinor = Number(b.spend_cap || 0);
        // spend_cap = 0 (ou um valor absurdamente alto) significa "sem limite definido" na API da Meta
        const hasCap = capMinor > 0 && capMinor < 100000000000;
        const remaining = hasCap ? (capMinor - spentMinor) / 100 : null;
        wrap.appendChild(el("div", { class: "row between", style: "margin-bottom:6px;" }, [
          el("span", { class: "muted small" }, b.name || "Conta"),
          el("span", {}, remaining != null
            ? `${fmtMoney(remaining, b.currency)} disponível (de ${fmtMoney(capMinor / 100, b.currency)} definido)`
            : "Sem limite de gasto definido nesta conta"),
        ]));
      }
      body.appendChild(wrap);
    }

    // Region table
    if (metrics.has("region_leads")) {
      const card = el("div", { class: "card" });
      card.appendChild(el("div", { class: "card-title" }, "Regiões com mais leads"));
      if (!regionsSorted.length) {
        card.appendChild(el("div", { class: "empty-state" }, "Sem dados de região no período."));
      } else {
        const maxLeads = Math.max(...regionsSorted.map((r) => r.leads), 1);
        const table = el("table", { class: "region-table" });
        table.appendChild(el("tr", {}, [
          el("th", {}, "Região"),
          el("th", {}, "Leads"),
          el("th", {}, "Custo por lead"),
          el("th", {}, "Investimento"),
        ]));
        for (const r of regionsSorted) {
          const barWidth = Math.max(4, Math.round((r.leads / maxLeads) * 60));
          const regionCpl = r.leads > 0 ? r.spend / r.leads : null;
          table.appendChild(el("tr", {}, [
            el("td", {}, r.region),
            el("td", {}, [el("span", { class: "rank-bar", style: `width:${barWidth}px;` }), fmtNumber(r.leads)]),
            el("td", {}, regionCpl != null ? fmtMoney(regionCpl, currency) : "—"),
            el("td", {}, fmtMoney(r.spend, currency)),
          ]));
        }
        card.appendChild(table);
      }
      body.appendChild(card);
    }

    // Anúncios em destaque
    if (metrics.has("creative_thumbs")) {
      const card = el("div", { class: "card" });
      card.appendChild(el("div", { class: "card-title" }, "Anúncios em destaque"));
      if (!creatives.length) {
        card.appendChild(el("div", { class: "empty-state" }, "Nenhum anúncio ativo com dados no período."));
      } else {
        const table = el("table", { class: "region-table" });
        table.appendChild(el("tr", {}, [
          el("th", {}, "Anúncio"),
          el("th", {}, "Leads"),
          el("th", {}, "Custo/lead"),
          el("th", {}, "Investimento"),
          el("th", {}, "CTR"),
          el("th", {}, "CPC"),
          el("th", {}, "CPM"),
          el("th", {}, "Frequência"),
        ]));
        for (const c of creatives) {
          const costPerLead = c.leads > 0 ? c.spend / c.leads : null;
          const nameCell = el("div", { class: "row", style: "gap:8px;flex-wrap:nowrap;" }, [
            c.thumb ? el("img", { src: c.thumb, alt: "", style: "width:36px;height:36px;border-radius:6px;object-fit:cover;flex-shrink:0;" }) : null,
            el("span", { style: "font-size:13px;" }, c.name || "—"),
          ]);
          table.appendChild(el("tr", {}, [
            el("td", {}, nameCell),
            el("td", {}, fmtNumber(c.leads)),
            el("td", {}, costPerLead != null ? fmtMoney(costPerLead, currency) : "—"),
            el("td", {}, fmtMoney(c.spend, currency)),
            el("td", {}, fmtPct(c.ctr)),
            el("td", {}, c.cpc != null ? fmtMoney(c.cpc, currency) : "—"),
            el("td", {}, c.cpm != null ? fmtMoney(c.cpm, currency) : "—"),
            el("td", {}, c.frequency != null ? c.frequency.toFixed(2) : "—"),
          ]));
        }
        card.appendChild(table);
      }
      body.appendChild(card);
    }

    if (!body.children.length) {
      body.appendChild(el("div", { class: "empty-state" }, "Nenhuma métrica selecionada. Clique em \"Métricas\" pra escolher o que aparece aqui."));
    }
  } catch (err) {
    body.innerHTML = "";
    body.appendChild(el("div", { class: "empty-state" }, `Não consegui carregar os dados: ${err.message}`));
  }
}

// ---------------- Export PDF ----------------

$("#btn-export-pdf").addEventListener("click", async () => {
  const node = $("#report-print-area");
  const btn = $("#btn-export-pdf");
  btn.disabled = true;
  btn.textContent = "Gerando...";
  try {
    const canvas = await html2canvas(node, { scale: 2, backgroundColor: "#ffffff" });
    const imgData = canvas.toDataURL("image/png");
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const imgWidth = pageWidth - 40;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;
    let heightLeft = imgHeight;
    let position = 20;
    pdf.addImage(imgData, "PNG", 20, position, imgWidth, imgHeight);
    heightLeft -= pageHeight;
    while (heightLeft > 0) {
      position = heightLeft - imgHeight + 20;
      pdf.addPage();
      pdf.addImage(imgData, "PNG", 20, position, imgWidth, imgHeight);
      heightLeft -= pageHeight;
    }
    const client = state.clients.find((c) => c.id === state.currentClientId);
    const filename = `relatorio-${(client?.name || "cliente").toLowerCase().replace(/\s+/g, "-")}-${new Date().toISOString().slice(0,10)}.pdf`;
    pdf.save(filename);
  } catch (err) {
    toast("Erro ao gerar PDF: " + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Baixar PDF";
  }
});

// init
renderAuthState();

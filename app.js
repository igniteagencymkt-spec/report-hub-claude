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
  { key: "instagram_profile", label: "Perfil do Instagram (seguidores, alcance)" },
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

// Plugin local (sem CDN extra) que escreve o valor de cada barra/ponto acima dela —
// essencial pro relatório em PDF, onde não existe "passar o mouse" pra ler o tooltip.
const valueLabelPlugin = {
  id: "valueLabels",
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    chart.data.datasets.forEach((dataset, i) => {
      const meta = chart.getDatasetMeta(i);
      if (meta.hidden) return;
      meta.data.forEach((el, index) => {
        const value = dataset.data[index];
        if (value == null) return;
        ctx.save();
        ctx.fillStyle = "#16263d";
        ctx.font = "600 11px Inter, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(String(value), el.x, el.y - 8);
        ctx.restore();
      });
    });
  },
};

// Legenda de gráficos de pizza/rosca mostrando "Rótulo: valor" direto ao lado do
// gráfico (sem depender de hover, que não existe no PDF impresso).
function legendWithValues() {
  return {
    position: "bottom",
    labels: {
      color: "#16263d",
      font: { size: 15, weight: "600" },
      boxWidth: 16,
      boxHeight: 16,
      padding: 16,
      generateLabels(chart) {
        const data = chart.data;
        const meta = chart.getDatasetMeta(0);
        return data.labels.map((label, i) => {
          const value = data.datasets[0].data[i];
          const style = meta.controller.getStyle(i);
          return {
            text: `${label}: ${value}`,
            fillStyle: style.backgroundColor,
            strokeStyle: style.borderColor,
            lineWidth: style.borderWidth,
            hidden: meta.data[i]?.hidden || false,
            index: i,
          };
        });
      },
    },
  };
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
  } else if (datePreset === "maximum") {
    // A API de Insights da Meta só guarda dados de ~37 meses pra trás — não dá
    // pra pedir mais do que isso, então "máximo" já busca exatamente esse teto.
    since = new Date(today.getFullYear(), today.getMonth() - 37, today.getDate());
    until = today;
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
  agencySettings: null,
};

// ---------------- Helpers ----------------

// Ícones de origem (selo "Métricas de X"), como no relatório de referência.
// Monocromáticos/simplificados — identificam a plataforma de forma factual,
// sem reproduzir arte de marca.
const META_ICON_SVG = `<svg viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg">
  <circle cx="18" cy="18" r="18" fill="#0866FF"/>
  <path d="M20.1 18.4h2.6l.4-3h-3V13.8c0-.87.24-1.46 1.5-1.46h1.6V9.65c-.28-.04-1.23-.12-2.34-.12-2.32 0-3.9 1.4-3.9 3.98v2.44h-2.6v3h2.6v8.2h3.14z" fill="#fff"/>
</svg>`;
const INSTAGRAM_ICON_SVG = `<svg viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="igGrad" cx="30%" cy="107%" r="150%">
      <stop offset="0%" stop-color="#fdf497"/>
      <stop offset="20%" stop-color="#fdf497"/>
      <stop offset="40%" stop-color="#fd5949"/>
      <stop offset="60%" stop-color="#d6249f"/>
      <stop offset="100%" stop-color="#285AEB"/>
    </radialGradient>
  </defs>
  <circle cx="18" cy="18" r="18" fill="url(#igGrad)"/>
  <rect x="10" y="10" width="16" height="16" rx="5" fill="none" stroke="#fff" stroke-width="1.6"/>
  <circle cx="18" cy="18" r="4.2" fill="none" stroke="#fff" stroke-width="1.6"/>
  <circle cx="23.3" cy="12.7" r="1.1" fill="#fff"/>
</svg>`;

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
    await loadAgencySettings();
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

  const bannerUrl = state.agencySettings?.banner_url || "";
  const bannerFileInput = el("input", { type: "file", accept: "image/*" });
  const bannerPreview = el("img", {
    src: bannerUrl,
    style: `max-width:100%;max-height:80px;border-radius:8px;border:1px solid var(--border);margin-bottom:10px;${bannerUrl ? "" : "display:none;"}`,
  });
  bannerFileInput.addEventListener("change", () => {
    const f = bannerFileInput.files[0];
    if (!f) return;
    bannerPreview.src = URL.createObjectURL(f);
    bannerPreview.style.display = "block";
  });

  const wrap = el("div", {}, [
    el("label", {}, "E-mail"),
    emailInput,
    el("label", {}, "Nova senha"),
    pwInput,
    el("label", {}, "Confirmar nova senha"),
    pwConfirm,
    el("p", { class: "small muted" }, "Pra trocar só o e-mail, deixe as senhas em branco. Pra trocar só a senha, deixe o e-mail como está."),
    el("div", { style: "margin-top:16px;padding-top:16px;border-top:1px solid var(--border);" }, [
      el("label", {}, "Banner da agência (aparece no rodapé de todos os relatórios)"),
      bannerPreview,
      bannerFileInput,
    ]),
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

    if (Object.keys(updates).length) {
      const { error } = await sb.auth.updateUser(updates);
      if (error) { toast(error.message, true); return false; }
    }

    const bannerFile = bannerFileInput.files[0];
    if (bannerFile) {
      const path = `${state.user.id}/banner-${Date.now()}.${bannerFile.name.split(".").pop()}`;
      const { error: upErr } = await sb.storage.from("agency-assets").upload(path, bannerFile, { upsert: true });
      if (upErr) { toast("Falha ao enviar banner: " + upErr.message, true); return false; }
      const { data: pub } = sb.storage.from("agency-assets").getPublicUrl(path);
      const { error: saveErr } = await sb.from("hub_agency_settings")
        .upsert({ user_id: state.user.id, banner_url: pub.publicUrl }, { onConflict: "user_id" });
      if (saveErr) { toast("Falha ao salvar banner: " + saveErr.message, true); return false; }
      await loadAgencySettings();
      await renderReport();
    }

    if (!Object.keys(updates).length && !bannerFile) { toast("Nada pra atualizar."); return; }

    if (updates.email) {
      toast("Confira seu e-mail atual e o novo pra confirmar a troca.");
    } else if (Object.keys(updates).length) {
      toast("Senha atualizada.");
    } else {
      toast("Banner atualizado.");
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

async function loadAgencySettings() {
  const { data } = await sb.from("hub_agency_settings").select("*").eq("user_id", state.user.id).maybeSingle();
  state.agencySettings = data || null;
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

const PLATFORM_LABELS = { meta: "Meta Ads", instagram: "Instagram" };

function renderAccounts() {
  const box = $("#accounts-list");
  box.innerHTML = "";
  if (!state.accounts.length) {
    box.appendChild(el("div", { class: "empty-state" }, "Nenhuma conta conectada ainda."));
    return;
  }
  for (const acc of state.accounts) {
    const platformLabel = PLATFORM_LABELS[acc.platform] || acc.platform;
    const idLabel = acc.platform === "instagram" ? `@${acc.account_name || acc.account_id}` : `act_${acc.account_id}`;
    const row = el("div", { class: "account-row" }, [
      el("div", {}, [
        el("div", {}, acc.account_name || acc.account_id),
        el("div", { class: "account-meta" }, `${idLabel} · ${platformLabel}`),
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

// Lista de integrações — hoje só Meta Ads e Instagram estão disponíveis (ambos
// via o mesmo login do Facebook); as demais ficam visíveis mas desabilitadas
// até termos a conexão real de cada uma.
const INTEGRATION_TYPES = [
  { key: "meta", label: "Meta Ads", desc: "Investimento, leads, CTR, CPC, CPM, públicos e anúncios da conta de anúncio.", available: true },
  { key: "instagram", label: "Instagram", desc: "Seguidores, alcance e visitas ao perfil do Instagram conectado via Facebook.", available: true },
  { key: "google_ads", label: "Google Ads", desc: "Em breve.", available: false },
  { key: "youtube", label: "YouTube", desc: "Em breve.", available: false },
  { key: "tiktok_ads", label: "TikTok Ads", desc: "Em breve.", available: false },
];

$("#btn-connect-account").addEventListener("click", () => {
  const wrap = el("div", { class: "metric-options", style: "grid-template-columns:1fr;" },
    INTEGRATION_TYPES.map((it) => {
      const row = el("div", {
        class: "metric-opt",
        style: it.available ? "cursor:pointer;" : "opacity:0.5;cursor:not-allowed;",
      }, [
        el("div", {}, [
          el("div", { style: "font-weight:600;" }, it.label + (it.available ? "" : " (em breve)")),
          el("div", { class: "small muted" }, it.desc),
        ]),
      ]);
      if (it.available) {
        row.addEventListener("click", () => {
          closeModal();
          if (window.HUB_CONFIG.FB_APP_ID) {
            connectViaFacebookLogin(it.key);
          } else if (it.key === "meta") {
            connectViaManualToken();
          } else {
            toast("Conecte um App ID do Facebook (config.js) pra usar login real e integrar o Instagram.", true);
          }
        });
      }
      return row;
    })
  );
  openModal("Nova integração", wrap, async () => {}, "Fechar"); // clicar no item já conecta; o botão só fecha
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

async function saveConnectedAccount(accountId, accountName, token, platform = "meta", extra = {}) {
  const { error } = await sb.from("hub_connected_accounts").insert({
    user_id: state.user.id,
    client_id: state.currentClientId,
    platform,
    account_id: accountId,
    account_name: accountName || null,
    access_token: token,
    ...extra,
  });
  if (error) throw error;
  toast(`"${accountName || accountId}" conectado.`);
  await loadAccounts(state.currentClientId);
  renderAccounts();
  await renderReport();
}

// ---- Login real com Facebook (só você loga — nunca o cliente) ----
// Acesso Padrão da Meta: funciona porque quem autentica é o admin deste app.
// Um único login cobre as duas integrações (Meta Ads e Instagram) — o escopo
// pedido já inclui as permissões das duas, então não precisa logar de novo
// pra trocar de plataforma.
async function connectViaFacebookLogin(platform = "meta") {
  const redirectUri = window.location.origin + window.location.pathname;
  const oauthState = Math.random().toString(36).slice(2);
  const scope = "ads_read,business_management,pages_show_list,pages_read_engagement,instagram_basic,instagram_manage_insights";
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
    toast("Login feito. Buscando suas contas...");
    const { data, error } = await sb.functions.invoke("meta-oauth-exchange", {
      body: { code, redirect_uri: redirectUri },
    });
    if (error) throw new Error(error.message || "Falha ao trocar o código pelo token.");
    if (data && data.error) throw new Error(data.error);
    const token = data.access_token;

    if (platform === "instagram") {
      // Instagram não é uma "conta" própria na API — é um Instagram Business Account
      // pendurado numa Página do Facebook. Por isso buscamos as Páginas que esse login
      // administra e filtramos só as que têm um Instagram profissional conectado.
      const pages = await metaCall(token, "me/accounts", {
        fields: "name,access_token,instagram_business_account{id,username,profile_picture_url}",
        limit: 200,
      });
      const withIg = (pages.data || []).filter((p) => p.instagram_business_account);
      if (!withIg.length) {
        toast("Login funcionou, mas nenhuma Página desse usuário tem um Instagram profissional conectado.", true);
        return;
      }
      openInstagramPicker(withIg);
      return;
    }

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

function openInstagramPicker(pages) {
  const select = el("select", {});
  for (const p of pages) {
    const ig = p.instagram_business_account;
    select.appendChild(el("option", { value: ig.id }, `@${ig.username} (via página "${p.name}")`));
  }
  const wrap = el("div", {}, [
    el("label", {}, "Conta do Instagram"),
    select,
    el("p", { class: "small muted" }, "Instagram profissional conectado às Páginas do Facebook que esse login administra. Escolha a do cliente."),
  ]);
  openModal("Escolher conta do Instagram", wrap, async () => {
    const igId = select.value;
    const chosenPage = pages.find((p) => p.instagram_business_account.id === igId);
    const ig = chosenPage.instagram_business_account;
    try {
      // O token que vale pra chamadas de Instagram é o da Página (chosenPage.access_token),
      // não o token de usuário do login — guardamos ele aqui.
      await saveConnectedAccount(ig.id, ig.username, chosenPage.access_token, "instagram", { business_id: chosenPage.id });
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

  const client = state.clients.find((c) => c.id === state.currentClientId);
  const titleInput = el("input", { type: "text", placeholder: `Padrão: ${client?.name || "Cliente"} — Relatório de performance`, value: state.reportConfig?.report_title || "" });
  const subtitleInput = el("input", { type: "text", placeholder: "Padrão: Período: (data selecionada)", value: state.reportConfig?.report_subtitle || "" });

  openModal("Métricas do relatório", el("div", {}, [
    el("label", {}, "Título do relatório"),
    titleInput,
    el("label", {}, "Subtítulo do relatório"),
    subtitleInput,
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
      report_title: titleInput.value.trim() || null,
      report_subtitle: subtitleInput.value.trim() || null,
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

// Contagem de leads: formulários nativos (Instant Forms) do Facebook/Instagram
// reportam o MESMO lead em dois action_types diferentes — "onsite_conversion.lead_grouped"
// (já deduplicado, é o número certo) e "lead" (bruto, pode contar o mesmo lead mais de uma
// vez). Por isso sempre priorizamos o valor deduplicado; "lead" só é usado como fallback
// pra contas que captam lead só por pixel/CAPI no site, sem formulário nativo.
function leadCount(actions) {
  const grouped = sumActionValue(actions, "onsite_conversion.lead_grouped");
  if (grouped > 0) return grouped;
  return sumActionValue(actions, "lead");
}

// "Cliques no link" é o clique que de fato leva a pessoa pra fora do anúncio
// (action_type "link_click"), diferente do campo genérico "clicks" da API, que soma
// qualquer interação (like, comentário, expandir imagem etc.) e por isso é maior e
// não reflete cliques reais no link.
function linkClicks(actions) {
  return sumActionValue(actions, "link_click");
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
    maximum: "período máximo (~37 meses)",
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
  const periodLabel = datePreset === "custom"
    ? `${fmtBR(range.since)} a ${fmtBR(range.until)}`
    : (periodLabels[datePreset] || datePreset);
  $("#report-title").textContent = state.reportConfig?.report_title
    || (client?.name ? `${client.name} — Relatório de performance` : "Relatório de performance");
  $("#report-subtitle").textContent = state.reportConfig?.report_subtitle || `Período: ${periodLabel}`;
  const timeRangeParam = JSON.stringify(range);

  try {
    let totalSpend = 0, totalLeads = 0, totalImpressions = 0, totalClicks = 0;
    let prevSpend = 0, prevLeads = 0, prevImpressions = 0, prevClicks = 0;
    let currency = "BRL";
    const regionMap = new Map();
    const platformMap = new Map();
    const genderMap = new Map();
    const ageMap = new Map();
    const dailyMap = new Map();
    let creatives = [];
    const customEvents = state.reportConfig?.custom_events || [];
    const customTotals = new Map(customEvents.map((e) => [e.action_type, 0]));

    const metaAccounts = state.accounts.filter((a) => a.platform === "meta");
    const igAccounts = state.accounts.filter((a) => a.platform === "instagram");

    for (const acc of metaAccounts) {
      const [accInfo, insights, prevInsights, regionInsights, platformInsights, genderInsights, ageInsights, dailyInsights, ads] = await Promise.all([
        metaCall(acc.access_token, `act_${acc.account_id}`, {
          fields: "name,currency",
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

      const row = (insights.data && insights.data[0]) || {};
      totalSpend += Number(row.spend || 0);
      totalLeads += leadCount(row.actions);
      totalImpressions += Number(row.impressions || 0);
      totalClicks += linkClicks(row.actions);
      for (const ce of customEvents) {
        customTotals.set(ce.action_type, (customTotals.get(ce.action_type) || 0) + sumActionValue(row.actions, ce.action_type));
      }

      const prow = (prevInsights.data && prevInsights.data[0]) || {};
      prevSpend += Number(prow.spend || 0);
      prevLeads += leadCount(prow.actions);
      prevImpressions += Number(prow.impressions || 0);
      prevClicks += linkClicks(prow.actions);

      for (const r of regionInsights.data || []) {
        const leads = leadCount(r.actions);
        if (!r.region) continue;
        const cur = regionMap.get(r.region) || { leads: 0, spend: 0, impressions: 0, clicks: 0 };
        cur.leads += leads;
        cur.spend += Number(r.spend || 0);
        cur.impressions += Number(r.impressions || 0);
        cur.clicks += linkClicks(r.actions);
        regionMap.set(r.region, cur);
      }

      for (const p of platformInsights.data || []) {
        const leads = leadCount(p.actions);
        if (!p.publisher_platform) continue;
        const cur = platformMap.get(p.publisher_platform) || { leads: 0, spend: 0, impressions: 0, clicks: 0 };
        cur.leads += leads;
        cur.spend += Number(p.spend || 0);
        cur.impressions += Number(p.impressions || 0);
        cur.clicks += linkClicks(p.actions);
        platformMap.set(p.publisher_platform, cur);
      }
      for (const g of genderInsights.data || []) {
        const leads = leadCount(g.actions);
        if (!g.gender || !leads) continue;
        genderMap.set(g.gender, (genderMap.get(g.gender) || 0) + leads);
      }
      for (const a of ageInsights.data || []) {
        const leads = leadCount(a.actions);
        if (!a.age) continue;
        ageMap.set(a.age, (ageMap.get(a.age) || 0) + leads);
      }
      for (const d of dailyInsights.data || []) {
        const leads = leadCount(d.actions);
        if (!d.date_start) continue;
        dailyMap.set(d.date_start, (dailyMap.get(d.date_start) || 0) + leads);
      }

      for (const ad of ads.data || []) {
        const adInsights = (ad.insights && ad.insights.data && ad.insights.data[0]) || {};
        const leads = leadCount(adInsights.actions);
        const adSpend = Number(adInsights.spend || 0);
        const adImpr = Number(adInsights.impressions || 0);
        const adClicks = linkClicks(adInsights.actions);
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
      .slice(0, 30); // Brasil tem 27 UFs; a folga cobre eventuais regiões extras (ex. "Desconhecido")
    creatives.sort((a, b) => b.leads - a.leads);
    creatives = creatives.slice(0, 5);
    const dailySorted = [...dailyMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const ageOrder = ["18-24", "25-34", "35-44", "45-54", "55-64", "65+"];
    const agesSorted = [...ageMap.entries()].sort((a, b) => ageOrder.indexOf(a[0]) - ageOrder.indexOf(b[0]));

    body.innerHTML = "";

    // Selo de origem dos dados do bloco de anúncios (Meta Ads). O Instagram, mais abaixo,
    // tem o próprio selo — cada integração mostra a métrica junto da sua própria origem.
    if (metrics.size && metaAccounts.length) {
      body.appendChild(el("div", { class: "source-badge" }, [
        el("span", { class: "source-badge-icon", html: META_ICON_SVG }),
        "Métricas de Meta Ads",
      ]));
    }

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
          options: { animation: false, plugins: { legend: legendWithValues() } },
        });
      }
    }

    // Tabela: leads, custo por lead, CTR, CPC, CPM e cliques no link por plataforma
    if (metrics.has("platform_breakdown") && platformMap.size) {
      const card = el("div", { class: "card" });
      card.appendChild(el("div", { class: "card-title" }, "Métricas por plataforma"));
      const table = el("table", { class: "region-table" });
      table.appendChild(el("tr", {}, [
        el("th", {}, "Plataforma"), el("th", {}, "Leads"), el("th", {}, "Custo/lead"), el("th", {}, "CTR"),
        el("th", {}, "CPC"), el("th", {}, "CPM"), el("th", {}, "Cliques no link"),
      ]));
      for (const [platform, v] of platformMap.entries()) {
        const pCpl = v.leads > 0 ? v.spend / v.leads : null;
        const pCtr = v.impressions > 0 ? (v.clicks / v.impressions) * 100 : null;
        const pCpc = v.clicks > 0 ? v.spend / v.clicks : null;
        const pCpm = v.impressions > 0 ? (v.spend / v.impressions) * 1000 : null;
        table.appendChild(el("tr", {}, [
          el("td", {}, platformLabel(platform)),
          el("td", {}, fmtNumber(v.leads)),
          el("td", {}, pCpl != null ? fmtMoney(pCpl, currency) : "—"),
          el("td", {}, fmtPct(pCtr)),
          el("td", {}, pCpc != null ? fmtMoney(pCpc, currency) : "—"),
          el("td", {}, pCpm != null ? fmtMoney(pCpm, currency) : "—"),
          el("td", {}, fmtNumber(v.clicks)),
        ]));
      }
      card.appendChild(el("div", { class: "table-scroll" }, [table]));
      body.appendChild(card);
    }

    // Gráfico: leads por dia (barra — mais fácil de ler valor exato que linha, principalmente no PDF)
    if (metrics.has("leads_by_day") && dailySorted.length) {
      const card = el("div", { class: "card chart-card" }, [
        el("div", { class: "card-title" }, "Leads por dia"),
        el("canvas", { id: "chart-daily" }),
      ]);
      body.appendChild(card);
      renderChart("chart-daily", {
        type: "bar",
        data: {
          labels: dailySorted.map(([d]) => d.slice(5).split("-").reverse().join("/")),
          datasets: [{ label: "Leads", data: dailySorted.map(([, v]) => v), backgroundColor: "#c9a66b" }],
        },
        plugins: [valueLabelPlugin],
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
        plugins: [valueLabelPlugin],
        options: {
          animation: false,
          plugins: { legend: { display: false } },
          scales: { x: { ticks: { color: "#64748b" } }, y: { beginAtZero: true, ticks: { color: "#64748b" } } },
        },
      });
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
          const nameCell = el("div", { class: "row", style: "gap:8px;flex-wrap:nowrap;max-width:170px;" }, [
            c.thumb ? el("img", { src: c.thumb, alt: "", style: "width:28px;height:28px;border-radius:6px;object-fit:cover;flex-shrink:0;" }) : null,
            el("span", { style: "font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;", title: c.name || "" }, c.name || "—"),
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
        card.appendChild(el("div", { class: "table-scroll" }, [table]));
      }
      body.appendChild(card);
    }

    // Region table — sempre por último, com todos os estados (Brasil tem 27 UFs)
    if (metrics.has("region_leads")) {
      const card = el("div", { class: "card" });
      card.appendChild(el("div", { class: "card-title" }, "Leads por região"));
      if (!regionsSorted.length) {
        card.appendChild(el("div", { class: "empty-state" }, "Sem dados de região no período."));
      } else {
        const maxLeads = Math.max(...regionsSorted.map((r) => r.leads), 1);
        const table = el("table", { class: "region-table" });
        table.appendChild(el("tr", {}, [
          el("th", {}, "Região"),
          el("th", {}, "Leads"),
          el("th", {}, "Custo por lead"),
          el("th", {}, "Cliques no link"),
          el("th", {}, "Custo por clique"),
          el("th", {}, "Investimento"),
        ]));
        for (const r of regionsSorted) {
          const barWidth = Math.max(4, Math.round((r.leads / maxLeads) * 60));
          const regionCpl = r.leads > 0 ? r.spend / r.leads : null;
          const regionCpc = r.clicks > 0 ? r.spend / r.clicks : null;
          table.appendChild(el("tr", {}, [
            el("td", {}, r.region),
            el("td", {}, [el("span", { class: "rank-bar", style: `width:${barWidth}px;` }), fmtNumber(r.leads)]),
            el("td", {}, regionCpl != null ? fmtMoney(regionCpl, currency) : "—"),
            el("td", {}, fmtNumber(r.clicks)),
            el("td", {}, regionCpc != null ? fmtMoney(regionCpc, currency) : "—"),
            el("td", {}, fmtMoney(r.spend, currency)),
          ]));
        }
        card.appendChild(el("div", { class: "table-scroll" }, [table]));
      }
      body.appendChild(card);
    }

    // Instagram (perfil conectado via Facebook) — seção própria, com seu próprio selo de origem
    if (metrics.has("instagram_profile") && igAccounts.length) {
      for (const ig of igAccounts) {
        try {
          const profile = await metaCall(ig.access_token, ig.account_id, {
            fields: "username,followers_count,media_count,profile_picture_url",
          });
          let reachTotal = null, profileViewsTotal = null;
          try {
            const igInsights = await metaCall(ig.access_token, `${ig.account_id}/insights`, {
              metric: "reach,profile_views",
              period: "day",
              since: range.since,
              until: range.until,
            });
            for (const m of igInsights.data || []) {
              const sum = (m.values || []).reduce((acc, v) => acc + Number(v.value || 0), 0);
              if (m.name === "reach") reachTotal = sum;
              if (m.name === "profile_views") profileViewsTotal = sum;
            }
          } catch {
            // Conta recém-conectada ou sem permissão de insights ainda — mostra só o perfil.
          }

          body.appendChild(el("div", { class: "source-badge" }, [
            el("span", { class: "source-badge-icon", html: INSTAGRAM_ICON_SVG }),
            `Instagram · @${profile.username}`,
          ]));
          const igGrid = el("div", { class: "stat-grid" });
          igGrid.appendChild(el("div", { class: "stat-tile" }, [
            el("div", { class: "stat-label" }, "Seguidores"),
            el("div", { class: "stat-value" }, fmtNumber(profile.followers_count)),
          ]));
          igGrid.appendChild(el("div", { class: "stat-tile" }, [
            el("div", { class: "stat-label" }, "Publicações"),
            el("div", { class: "stat-value" }, fmtNumber(profile.media_count)),
          ]));
          if (reachTotal != null) {
            igGrid.appendChild(el("div", { class: "stat-tile" }, [
              el("div", { class: "stat-label" }, "Alcance no período"),
              el("div", { class: "stat-value" }, fmtNumber(reachTotal)),
            ]));
          }
          if (profileViewsTotal != null) {
            igGrid.appendChild(el("div", { class: "stat-tile" }, [
              el("div", { class: "stat-label" }, "Visitas ao perfil"),
              el("div", { class: "stat-value" }, fmtNumber(profileViewsTotal)),
            ]));
          }
          body.appendChild(igGrid);
        } catch (igErr) {
          body.appendChild(el("div", { class: "empty-state" }, `Não consegui carregar o Instagram @${ig.account_name}: ${igErr.message}`));
        }
      }
    }

    // Banner da agência (rodapé do relatório, configurado em "Minha conta")
    if (state.agencySettings?.banner_url) {
      body.appendChild(el("div", { class: "report-banner" }, [
        el("img", { src: state.agencySettings.banner_url, alt: "" }),
      ]));
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
    // Página única (igual ao Reportei): em vez de recortar o conteúdo em várias folhas
    // A4, o tamanho da própria página do PDF é calculado pra caber o relatório inteiro
    // de uma vez, com uma margem fixa de 20pt em volta.
    const margin = 20;
    const pageWidthPt = 595.28; // largura A4 em pt — mantém a largura de leitura padrão
    const imgWidthPt = pageWidthPt - margin * 2;
    const imgHeightPt = (canvas.height * imgWidthPt) / canvas.width;
    const pdf = new jsPDF({
      orientation: imgHeightPt > imgWidthPt ? "portrait" : "landscape",
      unit: "pt",
      format: [pageWidthPt, imgHeightPt + margin * 2],
    });
    pdf.addImage(imgData, "PNG", margin, margin, imgWidthPt, imgHeightPt);
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

// ignite. report hub — lógica do app
// Nenhuma métrica é gravada no banco: tudo que aparece no relatório vem de
// uma chamada ao vivo pra Graph API (via edge function meta-proxy) no
// momento em que a tela é aberta.

const { createClient } = supabase;
const sb = createClient(window.HUB_CONFIG.SUPABASE_URL, window.HUB_CONFIG.SUPABASE_ANON_KEY);

const METRIC_DEFS = [
  { key: "spend", label: "Investimento" },
  { key: "leads", label: "Leads" },
  { key: "cpl", label: "Custo por lead (CPL)" },
  { key: "ctr", label: "CTR" },
  { key: "region_leads", label: "Leads por região" },
  { key: "creative_thumbs", label: "Criativos (thumbs)" },
  { key: "balance", label: "Saldo / fatura da conta" },
];
const DEFAULT_METRICS = METRIC_DEFS.map((m) => m.key);

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
  await Promise.all([loadAccounts(clientId), loadReportConfig(clientId)]);
  renderAccounts();
  await renderReport();
}

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
  const accInput = el("input", { type: "text", placeholder: "1234567890" });
  const tokenInput = el("input", { type: "text", placeholder: "EAAG..." });
  const wrap = el("div", {}, [
    el("label", {}, "ID da conta de anúncio (sem o act_)"),
    accInput,
    el("label", {}, "Access token (Business Manager)"),
    tokenInput,
    el("p", { class: "small muted" }, "Token de longa duração gerado no Business Manager (Graph API Explorer ou System User). Isso é temporário — assim que o login com Facebook estiver liberado, essa etapa some."),
  ]);

  openModal("Conectar conta Meta Ads", wrap, async () => {
    const accountId = accInput.value.trim().replace(/^act_/, "");
    const token = tokenInput.value.trim();
    if (!accountId || !token) { toast("Preencha os dois campos.", true); return false; }
    try {
      const info = await metaCall(token, `act_${accountId}`, { fields: "name,currency" });
      const { error } = await sb.from("hub_connected_accounts").insert({
        user_id: state.user.id,
        client_id: state.currentClientId,
        account_id: accountId,
        account_name: info.name || null,
        access_token: token,
      });
      if (error) throw error;
      toast(`Conta "${info.name || accountId}" conectada.`);
      await loadAccounts(state.currentClientId);
      renderAccounts();
      await renderReport();
    } catch (err) {
      toast(err.message || "Não consegui validar esse token/conta.", true);
      return false;
    }
  }, "Conectar");
});

// ---------------- Report config (métricas) ----------------

async function loadReportConfig(clientId) {
  const { data, error } = await sb
    .from("hub_report_configs")
    .select("*")
    .eq("client_id", clientId)
    .limit(1)
    .maybeSingle();
  if (error) { toast(error.message, true); return; }
  state.reportConfig = data || { metrics: DEFAULT_METRICS, date_preset: "last_30d", custom_events: [] };
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

  const customWrap = el("div", {}, [el("p", { class: "small muted" }, "Procurando eventos de conversão desta conta...")]);

  openModal("Métricas do relatório", el("div", {}, [
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

  try {
    let totalSpend = 0, totalLeads = 0, totalImpressions = 0, totalClicks = 0;
    let currency = "BRL";
    let balances = [];
    const regionMap = new Map(); // region -> {leads, spend}
    let creatives = [];
    const customEvents = state.reportConfig?.custom_events || [];
    const customTotals = new Map(customEvents.map((e) => [e.action_type, 0]));

    for (const acc of state.accounts) {
      const [accInfo, insights, regionInsights, ads] = await Promise.all([
        metaCall(acc.access_token, `act_${acc.account_id}`, {
          fields: "name,currency,balance,amount_spent,spend_cap",
        }),
        metaCall(acc.access_token, `act_${acc.account_id}/insights`, {
          date_preset: datePreset,
          fields: "spend,actions,impressions,clicks",
        }),
        metrics.has("region_leads")
          ? metaCall(acc.access_token, `act_${acc.account_id}/insights`, {
              date_preset: datePreset,
              breakdowns: "region",
              fields: "spend,actions",
              limit: 50,
            })
          : Promise.resolve({ data: [] }),
        metrics.has("creative_thumbs")
          ? metaCall(acc.access_token, `act_${acc.account_id}/ads`, {
              fields: "name,creative{thumbnail_url},insights.date_preset(" + datePreset + "){actions,spend}",
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

      for (const r of regionInsights.data || []) {
        const leads = sumActionValue(r.actions, "lead") || sumActionValue(r.actions, "onsite_conversion.lead_grouped");
        if (!r.region) continue;
        const cur = regionMap.get(r.region) || { leads: 0, spend: 0 };
        cur.leads += leads;
        cur.spend += Number(r.spend || 0);
        regionMap.set(r.region, cur);
      }

      for (const ad of ads.data || []) {
        const adInsights = (ad.insights && ad.insights.data && ad.insights.data[0]) || {};
        const leads = sumActionValue(adInsights.actions, "lead") || sumActionValue(adInsights.actions, "onsite_conversion.lead_grouped");
        creatives.push({
          name: ad.name,
          thumb: ad.creative && ad.creative.thumbnail_url,
          leads,
          spend: Number(adInsights.spend || 0),
        });
      }
    }

    const cpl = totalLeads > 0 ? totalSpend / totalLeads : null;
    const ctr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : null;
    const regionsSorted = [...regionMap.entries()]
      .map(([region, v]) => ({ region, ...v }))
      .sort((a, b) => b.leads - a.leads)
      .slice(0, 10);
    creatives.sort((a, b) => b.leads - a.leads);
    creatives = creatives.slice(0, 8);

    body.innerHTML = "";

    // Stat tiles
    const tiles = [];
    if (metrics.has("spend")) tiles.push(["Investimento", fmtMoney(totalSpend, currency)]);
    if (metrics.has("leads")) tiles.push(["Leads", fmtNumber(totalLeads)]);
    if (metrics.has("cpl")) tiles.push(["CPL", cpl != null ? fmtMoney(cpl, currency) : "—"]);
    if (metrics.has("ctr")) tiles.push(["CTR", fmtPct(ctr)]);
    for (const ce of customEvents) {
      tiles.push([ce.label, fmtNumber(customTotals.get(ce.action_type) || 0)]);
    }
    if (tiles.length) {
      const grid = el("div", { class: "stat-grid" });
      for (const [label, value] of tiles) {
        grid.appendChild(el("div", { class: "stat-tile" }, [
          el("div", { class: "stat-label" }, label),
          el("div", { class: "stat-value" }, value),
        ]));
      }
      body.appendChild(grid);
    }

    // Saldo
    if (metrics.has("balance")) {
      const wrap = el("div", { class: "card", style: "background:var(--navy-light); margin-bottom:20px;" });
      wrap.appendChild(el("div", { class: "card-title" }, "Saldo / fatura"));
      for (const b of balances) {
        const spentMinor = Number(b.amount_spent || 0);
        const balMinor = Number(b.balance || 0);
        wrap.appendChild(el("div", { class: "row between", style: "margin-bottom:6px;" }, [
          el("span", { class: "muted small" }, b.name || "Conta"),
          el("span", {}, `Gasto no ciclo: ${fmtMoney(spentMinor / 100, b.currency)} · Saldo/fatura: ${fmtMoney(balMinor / 100, b.currency)}`),
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
          el("th", {}, "Investimento"),
        ]));
        for (const r of regionsSorted) {
          const barWidth = Math.max(4, Math.round((r.leads / maxLeads) * 60));
          table.appendChild(el("tr", {}, [
            el("td", {}, r.region),
            el("td", {}, [el("span", { class: "rank-bar", style: `width:${barWidth}px;` }), fmtNumber(r.leads)]),
            el("td", {}, fmtMoney(r.spend, currency)),
          ]));
        }
        card.appendChild(table);
      }
      body.appendChild(card);
    }

    // Creatives
    if (metrics.has("creative_thumbs")) {
      const card = el("div", { class: "card" });
      card.appendChild(el("div", { class: "card-title" }, "Criativos em destaque (por leads)"));
      if (!creatives.length) {
        card.appendChild(el("div", { class: "empty-state" }, "Nenhum anúncio ativo com dados no período."));
      } else {
        const grid = el("div", { class: "creative-grid" });
        for (const c of creatives) {
          const cc = el("div", { class: "creative-card" });
          if (c.thumb) cc.appendChild(el("img", { src: c.thumb, alt: c.name || "" }));
          cc.appendChild(el("div", { class: "cc-body" }, [
            el("div", { class: "cc-name" }, c.name || "—"),
            el("div", { class: "cc-leads" }, `${fmtNumber(c.leads)} leads`),
          ]));
          grid.appendChild(cc);
        }
        card.appendChild(grid);
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

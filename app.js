/* J.A.R.V.I.S. Cloud – Web-App, die auch funktioniert, wenn der Gaming-PC aus ist.
 * Daten liegen in Supabase (Zürich) und sind nur für das freigeschaltete Besitzer-Konto lesbar (Zeilenschutz in der Datenbank).
 * Änderungen hier werden markiert und vom PC-JARVIS übernommen, sobald er läuft (Abgleich alle 30 s). */
"use strict";
(() => {
  const cfg = window.JARVIS_CLOUD;
  const sb = window.supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  const TZ = "Europe/Zurich";
  const app = document.getElementById("app");
  const st = { session: null, tab: safeGet("jarvis.tab") || "heute", data: null, owner: true, recovery: false, q: "" };

  function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
  function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* egal */ } }

  // ── kleine DOM-Hilfe (nur textContent → kein HTML aus Daten) ──
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "html") el.innerHTML = v; // nur für feste SVG-Symbole unten
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  }
  const ICON = {
    heute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    aufgaben: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 12 3 3 6-6"/></svg>',
    kalender: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
    gedaechtnis: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 3a4 4 0 0 0-4 4v1a3 3 0 0 0 0 6v1a4 4 0 0 0 4 4h1V3H9ZM15 3a4 4 0 0 1 4 4v1a3 3 0 0 1 0 6v1a4 4 0 0 1-4 4h-1V3h1Z"/></svg>',
    meldungen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4l2-2ZM10 20a2 2 0 0 0 4 0"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
    tick: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3"><path d="m5 12 5 5 9-10"/></svg>',
  };
  const icon = (n) => h("span", { html: ICON[n], "aria-hidden": "true" });

  // ── Zeit ──
  const fmt = (d, o) => new Intl.DateTimeFormat("de-CH", { timeZone: TZ, ...o }).format(new Date(d));
  const dayKey = (d) => fmt(d, { year: "numeric", month: "2-digit", day: "2-digit" });
  const todayKey = () => dayKey(new Date());
  const timeOf = (d) => fmt(d, { hour: "2-digit", minute: "2-digit" });
  const dayLabel = (d) => {
    const k = dayKey(d);
    if (k === todayKey()) return "Heute";
    if (k === dayKey(Date.now() + 86400000)) return "Morgen";
    return fmt(d, { weekday: "long", day: "numeric", month: "long" });
  };
  const ago = (d) => {
    const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
    if (s < 60) return "gerade eben";
    if (s < 3600) return `vor ${Math.round(s / 60)} min`;
    if (s < 86400) return `vor ${Math.round(s / 3600)} h`;
    return `am ${fmt(d, { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })}`;
  };
  /** Datum (YYYY-MM-DD) + Uhrzeit (HH:MM) in Zürich → ISO mit richtiger Zeitzone (inkl. Sommerzeit). */
  function zurichIso(date, time) {
    const guess = new Date(`${date}T${time || "00:00"}:00Z`);
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(guess).map((p) => [p.type, p.value]));
    const asZurich = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
    return new Date(guess.getTime() - (asZurich - guess.getTime())).toISOString();
  }

  function toast(text) {
    const t = h("div", { class: "toast", role: "status" }, text);
    document.body.append(t);
    setTimeout(() => t.remove(), 2600);
  }

  // ── Daten ──
  async function load() {
    const now = Date.now();
    const [tasks, events, memories, notes, pc] = await Promise.all([
      sb.from("tasks").select("*").eq("deleted", false).order("status").order("priority").order("due_at", { nullsFirst: false }).limit(1000),
      sb.from("events").select("*").eq("deleted", false).gte("ends_at", new Date(now - 86400000).toISOString()).lte("starts_at", new Date(now + 60 * 86400000).toISOString()).order("starts_at").limit(500),
      sb.from("memories").select("*").eq("deleted", false).order("updated_at", { ascending: false }).limit(500),
      sb.from("notifications").select("*").eq("deleted", false).order("created_at", { ascending: false }).limit(100),
      sb.from("pc_status").select("*").maybeSingle(),
    ]);
    const err = [tasks, events, memories, notes, pc].find((r) => r.error);
    if (err) throw err.error;
    st.owner = !!pc.data; // Zeile existiert immer – unsichtbar heisst: Konto nicht freigeschaltet
    st.data = { tasks: tasks.data, events: events.data, memories: memories.data, notes: notes.data, pc: pc.data };
  }
  async function act(promise, ok) {
    const { error } = await promise;
    if (error) { toast(`Fehler: ${error.message}`); return; }
    if (ok) toast(ok);
    await refresh();
  }
  async function refresh() {
    if (!st.session) return render();
    try { await load(); } catch (e) { toast(`Laden fehlgeschlagen: ${e.message || e}`); }
    render();
  }

  // ── Ansichten ──
  function pcChip() {
    const pc = st.data && st.data.pc;
    if (!pc || !pc.last_sync_at) return h("span", { class: "chip" }, h("span", { class: "dot" }), "PC noch nie verbunden");
    const online = Date.now() - new Date(pc.last_sync_at).getTime() < 120000;
    return h("span", { class: "chip", title: `Letzter Abgleich ${fmt(pc.last_sync_at, { dateStyle: "medium", timeStyle: "short" })}` },
      h("span", { class: `dot ${online ? "ok" : "warn"}` }), online ? "PC online" : `PC aus · ${ago(pc.last_sync_at)}`);
  }
  const pendingTag = (r) => (r.dirty ? h("span", { class: "pending", title: "Wird übernommen, sobald der PC läuft" }, "⟳ wartet auf PC") : null);

  function viewHeute() {
    const d = st.data;
    const hour = +fmt(new Date(), { hour: "2-digit", hourCycle: "h23" });
    const greet = hour < 11 ? "Guten Morgen" : hour < 18 ? "Guten Tag" : "Guten Abend";
    const open = d.tasks.filter((t) => t.status !== "done");
    const today = d.events.filter((e) => dayKey(e.starts_at) === todayKey() || (new Date(e.starts_at) < new Date() && new Date(e.ends_at) > new Date()));
    const due = open.filter((t) => t.due_at && new Date(t.due_at).getTime() < Date.now() + 86400000);
    const unread = d.notes.filter((n) => !n.read);
    return [
      h("div", { class: "card" },
        h("p", { class: "hello" }, `${greet}, Chef.`),
        h("p", { class: "hint" }, fmt(new Date(), { weekday: "long", day: "numeric", month: "long" }), " · ", today.length ? `${today.length} Termin${today.length > 1 ? "e" : ""} heute` : "keine Termine heute"),
        h("div", { class: "stats" },
          h("div", { class: "stat" }, h("b", {}, open.length), h("span", {}, "offene Aufgaben")),
          h("div", { class: "stat" }, h("b", {}, due.length), h("span", {}, "fällig ≤ 24 h")),
          h("div", { class: "stat" }, h("b", {}, unread.length), h("span", {}, "neue Meldungen")))),
      h("div", { class: "card" }, h("h2", {}, "Heute im Kalender"), today.length ? eventList(today) : h("p", { class: "empty" }, "Nichts geplant.")),
      h("div", { class: "card" }, h("h2", {}, "Fällig"), due.length ? taskList(due) : h("p", { class: "empty" }, "Nichts fällig – gut gemacht.")),
      unread.length ? h("div", { class: "card" }, h("h2", {}, "Neue Meldungen"), noteList(unread.slice(0, 3))) : null,
    ];
  }

  function taskList(tasks) {
    return h("ul", { class: "list" }, tasks.map((t) => {
      const done = t.status === "done";
      const late = t.due_at && !done && new Date(t.due_at) < new Date();
      return h("li", { class: done ? "done" : "" },
        h("span", { class: `prio p${t.priority}` }),
        h("button", { class: `check ${done ? "on" : ""}`, "aria-label": done ? "Als offen markieren" : "Erledigt", onclick: () => act(sb.from("tasks").update({ status: done ? "todo" : "done" }).eq("id", t.id), done ? "Wieder offen" : "Erledigt ✓") }, done ? icon("tick") : null),
        h("div", { class: "grow" },
          h("div", { class: "title" }, t.title),
          h("div", { class: "meta" },
            t.due_at ? h("span", { class: late ? "late" : "" }, `${late ? "überfällig · " : ""}${dayLabel(t.due_at)} ${timeOf(t.due_at)}`) : null,
            t.list_name ? ` · ${t.list_name}` : t.source === "ios-reminders" ? " · iPhone" : "",
            t.project_name ? ` · ${t.project_name}` : "", " ", pendingTag(t))),
        h("button", { class: "icon-btn", "aria-label": "Löschen", onclick: () => confirm(`„${t.title}“ löschen?`) && act(sb.from("tasks").update({ deleted: true }).eq("id", t.id), "Gelöscht") }, icon("trash")));
    }));
  }

  function viewAufgaben() {
    const d = st.data;
    const open = d.tasks.filter((t) => t.status !== "done");
    const done = d.tasks.filter((t) => t.status === "done").slice(0, 30);
    const f = h("form", { class: "add", onsubmit: (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const title = String(fd.get("title") || "").trim();
      if (!title) return;
      const date = fd.get("date"), time = fd.get("time");
      void act(sb.from("tasks").insert({ title, priority: Number(fd.get("prio")), due_at: date ? zurichIso(date, time || "09:00") : null }), "Aufgabe angelegt");
      e.target.reset();
    } },
      h("input", { name: "title", placeholder: "Neue Aufgabe oder Erinnerung …", maxlength: "300", required: true, "aria-label": "Titel" }),
      h("div", { class: "row" },
        h("input", { name: "date", type: "date", "aria-label": "Fällig am" }),
        h("input", { name: "time", type: "time", "aria-label": "Uhrzeit" }),
        h("select", { name: "prio", "aria-label": "Priorität" }, h("option", { value: "3" }, "Normal"), h("option", { value: "2" }, "Wichtig"), h("option", { value: "1" }, "Kritisch"), h("option", { value: "4" }, "Niedrig")),
        h("button", { class: "btn", type: "submit" }, "Hinzufügen")));
    return [
      h("div", { class: "card" }, h("h2", {}, "Neu"), f),
      h("div", { class: "card" }, h("h2", {}, "Offen", h("span", { class: "count" }, open.length)), open.length ? taskList(open) : h("p", { class: "empty" }, "Keine offenen Aufgaben.")),
      done.length ? h("div", { class: "card" }, h("h2", {}, "Erledigt (14 Tage)"), taskList(done)) : null,
    ];
  }

  function eventList(events) {
    return h("ul", { class: "list" }, events.map((e) => h("li", {},
      h("span", { class: "time" }, e.all_day ? "ganzt." : timeOf(e.starts_at)),
      h("div", { class: "grow" },
        h("div", { class: "title" }, e.title),
        h("div", { class: "meta" }, e.all_day ? "" : `bis ${timeOf(e.ends_at)}`, e.location ? ` · ${e.location}` : "", " ", h("span", { class: "badge" }, e.calendar), " ", pendingTag(e))),
      e.read_only ? null : h("button", { class: "icon-btn", "aria-label": "Termin löschen", onclick: () => confirm(`Termin „${e.title}“ löschen?`) && act(sb.from("events").update({ deleted: true }).eq("id", e.id), "Termin gelöscht") }, icon("trash")))));
  }

  function viewKalender() {
    const byDay = new Map();
    for (const e of st.data.events) {
      const k = dayKey(e.starts_at);
      if (!byDay.has(k)) byDay.set(k, { label: dayLabel(e.starts_at), items: [] });
      byDay.get(k).items.push(e);
    }
    const f = h("form", { class: "add", onsubmit: (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.target);
      const title = String(fd.get("title") || "").trim();
      const date = String(fd.get("date") || "");
      if (!title || !date) return;
      const from = String(fd.get("from") || "09:00"), to = String(fd.get("to") || "");
      const starts = zurichIso(date, from);
      let ends = to ? zurichIso(date, to) : new Date(new Date(starts).getTime() + 3600000).toISOString();
      if (new Date(ends) < new Date(starts)) ends = new Date(new Date(starts).getTime() + 3600000).toISOString();
      void act(sb.from("events").insert({ title, starts_at: starts, ends_at: ends, location: String(fd.get("loc") || "") }), "Termin angelegt");
      ev.target.reset();
    } },
      h("input", { name: "title", placeholder: "Neuer Termin …", maxlength: "300", required: true, "aria-label": "Titel" }),
      h("div", { class: "row" },
        h("input", { name: "date", type: "date", required: true, value: fmt(new Date(), { year: "numeric", month: "2-digit", day: "2-digit" }).split(".").reverse().join("-"), "aria-label": "Datum" }),
        h("input", { name: "from", type: "time", value: "09:00", "aria-label": "Von" }),
        h("input", { name: "to", type: "time", "aria-label": "Bis" })),
      h("div", { class: "row" }, h("input", { name: "loc", placeholder: "Ort (optional)", maxlength: "300" }), h("button", { class: "btn", type: "submit" }, "Eintragen")));
    return [
      h("div", { class: "card" }, h("h2", {}, "Neuer Termin"), f, h("p", { class: "hint" }, "Landet im JARVIS-Kalender, sobald der PC läuft.")),
      h("div", { class: "card" }, h("h2", {}, "Nächste 60 Tage"),
        byDay.size ? [...byDay.values()].map((d) => [h("div", { class: "day" }, d.label), eventList(d.items)]) : h("p", { class: "empty" }, "Keine Termine.")),
    ];
  }

  function viewGedaechtnis() {
    const q = st.q.trim().toLowerCase();
    const list = st.data.memories.filter((m) => !q || m.content.toLowerCase().includes(q));
    const KIND = { fact: "Fakt", preference: "Vorliebe", goal: "Ziel", project: "Projekt", decision: "Entscheidung", temporary: "Vorübergehend", assumption: "Vermutung" };
    const f = h("form", { class: "add", onsubmit: (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const content = String(fd.get("content") || "").trim();
      if (!content) return;
      if (/\b(passw(o|ö)rt|pin|iban|kreditkarte|cvv|tan)\b/i.test(content)) { toast("Passwörter, PINs und Kartendaten speichert JARVIS bewusst nicht."); return; }
      void act(sb.from("memories").insert({ kind: String(fd.get("kind")), content }), "Gemerkt");
      e.target.reset();
    } },
      h("input", { name: "content", placeholder: "Merke dir …", maxlength: "1000", required: true, "aria-label": "Inhalt" }),
      h("div", { class: "row" },
        h("select", { name: "kind", "aria-label": "Art" }, Object.entries(KIND).map(([k, v]) => h("option", { value: k }, v))),
        h("button", { class: "btn", type: "submit" }, "Merken")));
    const search = h("input", { class: "search", type: "search", placeholder: "Gedächtnis durchsuchen …", value: st.q, "aria-label": "Suchen", oninput: (e) => { st.q = e.target.value; const pos = e.target.selectionStart; render(); const s = document.querySelector("input.search"); if (s) { s.focus(); s.setSelectionRange(pos, pos); } } });
    return [
      h("div", { class: "card" }, h("h2", {}, "Neu merken"), f, h("p", { class: "hint" }, "Sensible Einträge bleiben nur auf dem PC und erscheinen hier nicht.")),
      h("div", { class: "card" }, h("h2", {}, "Gedächtnis", h("span", { class: "count" }, list.length)), search,
        list.length ? h("ul", { class: "list" }, list.map((m) => h("li", {},
          h("div", { class: "grow" }, h("div", { class: "title" }, m.content), h("div", { class: "meta" }, KIND[m.kind] || m.kind, " ", pendingTag(m))),
          h("button", { class: "icon-btn", "aria-label": "Vergessen", onclick: () => confirm("Diesen Eintrag vergessen?") && act(sb.from("memories").update({ deleted: true }).eq("id", m.id), "Vergessen") }, icon("trash"))))) : h("p", { class: "empty" }, q ? "Nichts gefunden." : "Noch nichts gespeichert.")),
    ];
  }

  function noteList(notes) {
    const P = { critical: "Kritisch", important: "Wichtig", normal: "", info: "Info" };
    return h("ul", { class: "list" }, notes.map((n) => h("li", { class: n.read ? "" : "unread" },
      h("div", { class: "grow" },
        h("div", { class: "title" }, n.title),
        n.body ? h("div", { class: "meta" }, n.body) : null,
        h("div", { class: "meta" }, ago(n.created_at), P[n.priority] ? ` · ${P[n.priority]}` : "", " ", pendingTag(n))),
      n.read ? null : h("button", { class: "icon-btn", "aria-label": "Als gelesen markieren", onclick: () => act(sb.from("notifications").update({ read: true }).eq("id", n.id)) }, icon("tick")))));
  }
  function viewMeldungen() {
    const n = st.data.notes;
    return [h("div", { class: "card" }, h("h2", {}, "Meldungen", h("span", { class: "count" }, n.filter((x) => !x.read).length + " neu")), n.length ? noteList(n) : h("p", { class: "empty" }, "Keine Meldungen."))];
  }

  const TABS = [["heute", "Heute", viewHeute], ["aufgaben", "Aufgaben", viewAufgaben], ["kalender", "Kalender", viewKalender], ["gedaechtnis", "Gedächtnis", viewGedaechtnis], ["meldungen", "Meldungen", viewMeldungen]];

  function viewMain() {
    const tab = TABS.find((t) => t[0] === st.tab) || TABS[0];
    const unread = st.data ? st.data.notes.filter((n) => !n.read).length : 0;
    return [
      h("header", { class: "top" },
        h("div", { class: "orb sm", "aria-hidden": "true" }),
        h("div", {}, h("h1", {}, "J.A.R.V.I.S."), h("div", { class: "sub" }, "Cloud")),
        h("span", { class: "spacer" }), pcChip(),
        h("button", { class: "btn ghost", style: null, onclick: async () => { await sb.auth.signOut(); } }, "Abmelden")),
      st.owner ? (st.data ? tab[2]() : h("p", { class: "empty" }, "Lade …"))
        : h("div", { class: "card" }, h("h2", {}, "Kein Zugriff"), h("p", { class: "hint" }, "Dieses Konto ist nicht als Besitzer freigeschaltet oder die E-Mail-Adresse ist noch nicht bestätigt. Bitte den Bestätigungslink in der E-Mail öffnen und neu anmelden.")),
      h("nav", { class: "tabs", "aria-label": "Bereiche" }, h("div", { class: "inner" }, TABS.map(([id, label]) =>
        h("button", { "aria-current": st.tab === id ? "page" : null, onclick: () => { st.tab = id; safeSet("jarvis.tab", id); render(); window.scrollTo(0, 0); } },
          icon(id), label, id === "meldungen" && unread ? h("span", { class: "n" }, unread) : null)))),
    ];
  }

  function viewAuth(msg) {
    const box = h("div", { class: "msg", hidden: !msg }, msg ? msg.text : "");
    if (msg) box.className = `msg ${msg.kind || ""}`;
    const say = (text, kind) => { box.hidden = false; box.className = `msg ${kind || ""}`; box.textContent = text; };
    const redirectTo = location.origin + location.pathname;
    if (st.recovery) {
      return h("div", { class: "auth" }, h("div", { class: "orb" }), h("h1", {}, "NEUES PASSWORT"),
        h("form", { onsubmit: async (e) => {
          e.preventDefault();
          const pw = new FormData(e.target).get("pw");
          const { error } = await sb.auth.updateUser({ password: String(pw) });
          if (error) return say(error.message, "err");
          st.recovery = false; toast("Passwort geändert"); await refresh();
        } }, h("input", { name: "pw", type: "password", minlength: "10", autocomplete: "new-password", placeholder: "Neues Passwort (mind. 10 Zeichen)", required: true }), h("button", { class: "btn", type: "submit" }, "Speichern"), box));
    }
    const form = h("form", { onsubmit: async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      say("Anmelden …");
      const { error } = await sb.auth.signInWithPassword({ email: String(fd.get("email")).trim(), password: String(fd.get("pw")) });
      if (error) say(/confirm/i.test(error.message) ? "E-Mail-Adresse noch nicht bestätigt – bitte den Link in der E-Mail öffnen." : "Anmeldung fehlgeschlagen. E-Mail oder Passwort falsch.", "err");
    } },
      h("label", { class: "f" }, "E-Mail", h("input", { name: "email", type: "email", autocomplete: "username", required: true })),
      h("label", { class: "f" }, "Passwort", h("input", { name: "pw", type: "password", autocomplete: "current-password", minlength: "10", required: true })),
      h("button", { class: "btn", type: "submit" }, "Anmelden"),
      h("div", { class: "links" },
        h("button", { type: "button", onclick: async () => {
          const fd = new FormData(form);
          const email = String(fd.get("email") || "").trim(), pw = String(fd.get("pw") || "");
          if (!email || pw.length < 10) return say("Für ein neues Konto E-Mail und ein Passwort mit mindestens 10 Zeichen eingeben.", "err");
          const { error } = await sb.auth.signUp({ email, password: pw, options: { emailRedirectTo: redirectTo } });
          say(error ? error.message : "Fast fertig: Bitte den Bestätigungslink in der E-Mail öffnen, dann hier anmelden.", error ? "err" : "ok");
        } }, "Konto erstellen"),
        h("button", { type: "button", onclick: async () => {
          const email = String(new FormData(form).get("email") || "").trim();
          if (!email) return say("Bitte zuerst die E-Mail-Adresse eingeben.", "err");
          const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo });
          say(error ? error.message : "Falls das Konto existiert, kommt gleich eine E-Mail zum Zurücksetzen.", error ? "err" : "ok");
        } }, "Passwort vergessen?")),
      box);
    return h("div", { class: "auth" }, h("div", { class: "orb" }), h("h1", {}, "J.A.R.V.I.S."), h("p", { class: "hint" }, "Cloud – auch wenn dein PC aus ist"), form);
  }

  function render(msg) {
    app.replaceChildren(...[st.session && !st.recovery ? viewMain() : viewAuth(msg)].flat().filter(Boolean));
  }

  // ── Start ──
  sb.auth.onAuthStateChange((event, session) => {
    st.session = session;
    if (event === "PASSWORD_RECOVERY") st.recovery = true;
    if (event === "SIGNED_OUT") st.data = null;
    setTimeout(() => void refresh(), 0);
  });
  sb.auth.getSession().then(({ data }) => { st.session = data.session; void refresh(); });
  setInterval(() => { if (document.visibilityState === "visible" && st.session) void refresh(); }, 30000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && st.session) void refresh(); });
})();

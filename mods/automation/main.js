// Automations: starts coding agents and scripts when their Trigger fires, in tabs of a space
// of their own, and keeps a history of every Run. The panel and the dialog are the same view;
// every panel copy runs the engine, and only the holder of the lease fires and follows Runs.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, TextareaState } from "gpui-base";
import { theme, appHome, checking, props } from "herdr";
import { loadSettings } from "./settings.js";
import { store, automationError, dayKey, EMPTY_STATE, STEP_KEYS } from "./store.js";
import { createEngine } from "./engine.js";
import { nextTimes } from "./cron.js";
import { goingRun, ms, slug, DEFAULT_SETTINGS } from "./runs.js";
import { host, io, lease } from "./host.js";
import { repoRoot } from "./shell.js";
import { TEXT, span } from "./views/ui.js";
import { header, list } from "./views/list.js";
import { detail } from "./views/detail.js";
import { form } from "./views/form.js";
import { formTrigger, catchUpText, catchUpValue } from "./views/form-model.js";

const TICK_MS = 5000;
const DAY = 24 * 60 * 60000;
// The run files the panel shows for an ended Run, in pipeline order.
const OUTPUTS = [["Check", "check.txt"], ["Check (stderr)", "check.err.txt"], ["Pre-script", "pre.txt"], ["Pre-script (stderr)", "pre.err.txt"],
  ["Terminal (last 200 lines)", "tail.txt"], ["Post-script", "post.txt"], ["Post-script (stderr)", "post.err.txt"], ["Result file", "out/result.md"]];

const cleaned = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export default class Automation extends View {
  init(_props, cx) {
    this.overlay = props()?.overlay ?? null;
    // A block with props {part: "engine"} draws nothing: Herdr starts a copy only once it has
    // shown, so a panel hidden behind its button would fire nothing until someone opened it.
    this.headless = props()?.part === "engine";
    this.settings = DEFAULT_SETTINGS;
    this.problems = [];
    this.store = store(`${appHome()}/data/automation`, io);
    this.doc = { paused: false, automations: [], problems: [] };
    this.state = EMPTY_STATE;
    this.history = [];
    // The raw text last read of automations.json, state.json and the history, to tell a change.
    this.raw = {};
    this.openTabs = new Set();
    this.nextCache = { minute: null, times: new WeakMap() };
    // Set when what is shown changed since the last render.
    this.dirty = false;
    this.shownElapsed = "";
    this.screen = { name: "list" };
    this.form = null;
    this.ask = null;
    this.output = null;
    this.error = null;
    this.mono = host.monoFont();
    this.engine = createEngine({ store: this.store, host, lease, id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, settings: () => this.settings });
    cx.spawn(async (cx) => {
      ({ settings: this.settings, problems: this.problems } = await loadSettings("automation", DEFAULT_SETTINGS));
      await this.reload();
      cx.notify();
    });
    if (checking()) return;
    if (this.overlay) host.dialogShown(true);
    cx.timer.every(TICK_MS, (cx) => this.tick(cx));
  }

  async close() {
    this.engine.release();
    if (this.overlay) host.dialogShown(false);
  }

  tick(cx) {
    cx.spawn(async (cx) => {
      // The dialog's copy never leads: Herdr cancels its tasks soon after it closes.
      try { if (!this.overlay) await this.engine.tick(); this.error = null; } catch (e) { this.error = `The engine stopped a tick: ${e?.message ?? e}`; }
      if (this.headless) return;
      await this.reload();
      // Each redraw redraws the window: only for a change on screen, which the form does not show.
      if (this.screen.name !== "form" && host.visible() && (this.dirty || this.elapsed() !== this.shownElapsed)) cx.notify();
    });
  }

  // The elapsed times shown for Runs going: seconds in the first minute, then minutes.
  elapsed() {
    const now = Date.now();
    return [...Object.values(this.state.runs).map((r) => r.started), ...Object.values(this.state.requests).map((r) => r.at)].map((t) => span(now - t)).join();
  }

  /** Reads the files again when their text changed; resolves whether anything shown changed. */
  async reload() {
    const s = this.store;
    let changed = false;
    try {
      const [doc, state] = await Promise.all([s.readText(s.files.automations), s.readText(s.files.state)]);
      if (doc !== this.raw.doc) { this.doc = s.automationsOf(doc); changed = true; }
      if (state !== this.raw.state) { this.state = s.stateOf(state); changed = true; }
      this.raw = { ...this.raw, doc, state };
      if (this.screen.name === "detail") {
        // A Run's events land in today's file and move it in state.json.
        const key = `${await s.readText(s.historyFile(dayKey(Date.now())))}\n${state}`;
        if (key !== this.raw.history) {
          this.history = await s.readHistory(Math.ceil(ms(this.settings, "historyRetention") / DAY));
          this.raw.history = key;
          changed = true;
        }
      }
    } catch (e) {
      this.error = `Cannot read the data folder: ${e?.message ?? e}`;
      changed = true;
    }
    this.dirty ||= changed;
    return changed;
  }

  /** The next time of `trigger`, worked out once a minute. */
  next(trigger) {
    const now = Date.now(), minute = Math.floor(now / 60000), c = this.nextCache;
    if (c.minute !== minute) Object.assign(c, { minute, times: new WeakMap() });
    if (!c.times.has(trigger)) c.times.set(trigger, nextTimes(trigger, now, 1)[0] ?? null);
    return c.times.get(trigger);
  }

  // Every change goes through the files, then the screen reads them again.
  act(cx, work) {
    cx.spawn(async (cx) => {
      try { await work(); } catch (e) { this.error = e?.message ?? String(e); }
      await this.reload();
      cx.notify();
    });
  }

  show(screen, cx) {
    this.screen = screen;
    this.output = null;
    this.ask = null;
    this.history = [];
    this.raw.history = null;
    if (cx) this.act(cx, async () => {});
  }

  going(id) { return goingRun(this.state, id); }
  tabOpen(run) { return Boolean(run?.tab) && this.openTabs.has(run.tab); }
  goTo(run) {
    host.goToTab(run.space, run.tab);
    this.closeDialog();
  }
  closeDialog() { if (this.overlay) host.closeDialog(this.overlay); }

  togglePaused(cx) { this.act(cx, () => this.store.updateAutomations((d) => ({ ...d, paused: !d.paused }))); }
  toggleEnabled(a, cx) {
    this.act(cx, () => this.store.updateAutomations((d) => ({ ...d, automations: d.automations.map((x) => (x?.id === a.id ? { ...x, enabled: x.enabled === false } : x)) })));
  }
  // The leader starts and stops Runs: the dialog's copy is cancelled soon after it closes.
  runNow(a, cx) {
    if (this.going(a.id)) this.error = `${a.name} is still going: this Run will be skipped.`;
    this.act(cx, () => this.engine.askRun(a));
  }
  stop(runId, cx) { this.act(cx, () => this.engine.askStop(runId)); }
  remove(a, cx) {
    this.ask = null;
    this.show({ name: "list" });
    this.act(cx, () => this.store.deleteAutomation(a.id));
  }

  /** A history row: its tab while it is open, else what the Run saved and its worktree. */
  openRun(e, cx) {
    if (this.tabOpen(e)) return this.goTo(e);
    this.act(cx, async () => {
      const sections = await Promise.all(OUTPUTS.map(async ([title, name]) => [title, await this.store.readRunFile(e.run, name).catch(() => null)]));
      this.output = {
        run: e.run, name: e.name, reason: e.reason ? `${e.status}: ${e.reason}` : e.status, branch: e.branch, path: e.worktree,
        sections: sections.filter(([, text]) => text?.trim()),
        worktree: await this.engine.worktree(e.run),
      };
    });
  }

  /** Open a tab here: a shell in the Run's worktree, in the Automations space. */
  openHere(o, cx) {
    this.act(cx, async () => this.goTo(await host.openTab({ space: this.settings.space, name: o.name, folder: o.worktree.path })));
  }

  /** Remove worktree; a dirty one only after the person said yes (`confirmed`). */
  removeWorktree(o, confirmed, cx) {
    if (o.worktree.dirty && !confirmed) { this.ask = { worktree: o.run }; return; }
    this.ask = null;
    this.act(cx, async () => {
      await this.engine.removeWorktree(o.run);
      if (this.output === o) this.output = { ...o, worktree: null };
    });
  }

  openForm(a, cx) {
    this.closeForm(cx);
    const tr = a?.trigger ?? { type: "schedule", preset: "daily", at: "09:00" };
    const text = (value, placeholder) => InputState.new({ value: value ?? "", placeholder });
    this.form = {
      id: a?.id ?? null, original: a ?? null,
      kind: a?.kind ?? "agent", agent: a?.agent ?? this.settings.agent, agents: [], agentsError: null,
      preset: tr.type === "schedule" ? tr.preset : tr.type, days: tr.days ?? [1, 2, 3, 4, 5], enabled: a?.enabled !== false, error: "",
      name: text(a?.name, "What it does"),
      folder: text(a?.folder, "/path/to/folder"),
      model: text(a?.model, "The agent's default"),
      args: text(a?.args?.join(" "), "--flag value"),
      prompt: TextareaState.new({ value: a?.prompt ?? "", placeholder: "The first message for the agent" }),
      command: TextareaState.new({ value: a?.command ?? "", placeholder: "make test" }),
      minutes: text(tr.minutes ? String(tr.minutes) : "15", "15"),
      at: text(tr.at ?? "09:00", "09:00"),
      cron: text(tr.cron ?? "0 9 * * 1-5", "0 9 * * 1-5"),
      agentStatus: tr.status ?? "done", inFolder: tr.inFolder === true,
      app: text(tr.app, "Any (claude, codex…)"),
      gitSource: tr.source ?? "local",
      gitBranch: text(tr.branch, "origin/main"),
      timeout: text(a?.timeout ? String(a.timeout) : "", "From the settings"),
      catchUp: text(catchUpText(a?.catchUp), "Default: 2h daily, none otherwise"),
      // null: the default, a worktree for an agent in a git repository.
      workspace: a?.workspace ?? null, isRepo: null,
      base: text(a?.base, "The remote's default branch"),
      requireResult: a?.requireResult === true,
    };
    for (const k of STEP_KEYS) {
      const s = a?.[k];
      this.form[`${k}Mode`] = s?.file ? "file" : "inline";
      this.form[k] = text(s?.file ?? s?.inline, "Shell text, or a file path");
      this.form[`${k}Timeout`] = text(s?.timeout ? String(s.timeout) : "", "60");
    }
    this.screen = { name: "form", back: this.screen };
    this.form.name.focus();
    const f = this.form;
    cx.spawn(async (cx) => {
      try { f.agents = await host.knownAgents(); } catch (e) { f.agentsError = `Cannot list the agents: ${e?.message ?? e}`; }
      cx.notify();
    });
    this.checkRepo(cx);
  }

  // Whether the form's folder is a git repository, which decides if a worktree is offered.
  checkRepo(cx) {
    const f = this.form, folder = f.folder.value().trim();
    if (!folder) return;
    cx.spawn(async (cx) => {
      const isRepo = Boolean(await repoRoot(host.exec, folder));
      if (this.form === f && f.folder.value().trim() === folder) f.isRepo = isRepo;
      cx.notify();
    });
  }

  closeForm(cx) {
    const f = this.form;
    if (!f) return;
    this.form = null;
    if (this.screen.name === "form") this.screen = this.screen.back ?? { name: "list" };
    // Released late because closing can run inside a field's own event.
    cx.timer.after(300, () => { for (const v of Object.values(f)) if (typeof v?.release === "function") v.release(); });
  }

  pickFolder(cx) {
    const f = this.form;
    cx.spawn(async (cx) => {
      const folder = await host.pickFolder().catch(() => null);
      if (folder && this.form === f) {
        f.folder.set_value(folder);
        f.isRepo = null;
        this.checkRepo(cx);
      }
      cx.notify();
    });
  }

  save(cx) {
    const f = this.form;
    const v = (k) => f[k].value().trim();
    const agent = f.kind === "agent";
    const timeout = v("timeout"), catchUp = v("catchUp");
    if (timeout && !(Number(timeout) > 0)) { f.error = "The timeout is a number of minutes above 0."; return; }
    const a = cleaned({
      ...f.original,
      id: f.id ?? `${slug(v("name"))}-${Date.now().toString(36)}`,
      name: v("name"), kind: f.kind, folder: v("folder"), trigger: formTrigger(f), enabled: f.enabled,
      agent: agent ? f.agent : undefined,
      model: agent && v("model") ? v("model") : undefined,
      args: agent && v("args") ? v("args").split(/\s+/) : undefined,
      prompt: agent ? f.prompt.value() : undefined,
      command: agent ? undefined : f.command.value(),
      timeout: timeout ? Number(timeout) : undefined,
      catchUp: catchUpValue(catchUp),
      workspace: f.workspace ?? undefined,
      base: f.workspace !== "folder" && v("base") ? v("base") : undefined,
      requireResult: f.requireResult || undefined,
      ...Object.fromEntries(STEP_KEYS.map((k) => {
        const body = v(k), secs = v(`${k}Timeout`);
        return [k, body ? cleaned({ [f[`${k}Mode`]]: body, timeout: secs ? Number(secs) : undefined }) : undefined];
      })),
    });
    const error = automationError(a);
    if (error) { f.error = `This Automation ${error}.`; return; }
    cx.spawn(async (cx) => {
      if ((a.trigger.type === "git" || a.workspace === "worktree") && !(await repoRoot(host.exec, a.folder))) {
        f.error = a.trigger.type === "git"
          ? "The folder is not a git repository, so a git Trigger has nothing to watch."
          : "The folder is not a git repository, so a Run cannot have a worktree. Choose Folder.";
        return cx.notify();
      }
      if (this.form !== f) return;
      const id = a.id;
      this.closeForm(cx);
      this.screen = { name: "detail", id };
      this.act(cx, () => this.store.updateAutomations((d) => ({
        ...d,
        automations: d.automations.some((x) => x?.id === id) ? d.automations.map((x) => (x?.id === id ? a : x)) : [...d.automations, a],
      })));
    });
  }

  render() {
    if (this.headless) return div();
    const t = theme();
    this.dirty = false;
    this.shownElapsed = this.elapsed();
    this.openTabs = host.openTabs();
    // A git Trigger whose last look failed, once per Automation until a look succeeds.
    const gitErrors = this.doc.automations.filter((a) => this.state.commits[a.id]?.error).map((a) => `${a.name}: ${this.state.commits[a.id].error}`);
    const notices = [this.error, ...this.problems, ...this.doc.problems, ...gitErrors].filter(Boolean);
    const body = this.screen.name === "form" && this.form ? form(this, t) : this.screen.name === "detail" ? detail(this, t) : list(this, t);
    return v_flex().id("root").size_full().bg(t.surface).text_size(TEXT.body).text_color(t.foreground)
      .child(header(this, t))
      .when(notices.length > 0, (el) => el.child(v_flex().flex_none().mx(8).mt(8).px(8).py(4).gap(2).rounded(6).bg(t.raised)
        .children(notices.map((n) => div().text_size(TEXT.note).text_color(t.blocked).child(n)))))
      .child(v_flex().id("body").flex_1().min_h(0).overflow_y_scrollbar().child(body));
  }
}

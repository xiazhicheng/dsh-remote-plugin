// Client half (hand-authored ModuleLoader bundle — no bundler required).
//
// One surface: both workspace `directoryFlow` holes, shadowing the shipped
// native picker at a lower priority so "添加工作区" offers
//   本地目录…  |  远程工作区（N）…（列出已保存的远程工作区，可直接打开/编辑/删除）  |  取消
// plus the 新建远程工作区（SSH）form. There is no settings page: everything a
// remote workspace needs lives in that flow.
//
// The host half serves all of it over the /remote-ssh HTTP route registered by
// src/index.ts, so this file needs no Typert code generation.
window.__ModuleLoader__.load({
	id: "dsh-remote-retry-llm-plugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require("react");
		const h = React.createElement;
		const { useState, useEffect, useCallback, useRef } = React;

		const ROUTE = "/remote-ssh";
		/** The live client context, captured by apply() for the components. */
		let pluginCtx = null;

		function service(name) {
			try {
				return pluginCtx && typeof pluginCtx.get === "function" ? pluginCtx.get(name) : undefined;
			} catch {
				return undefined;
			}
		}

		function pickLocalDirectory() {
			const desktop = globalThis.__DSH_DIRECTORY_PICKER__;
			if (desktop) return Promise.resolve(desktop.pick());
			const uiWorkspace = service("uiWorkspace");
			return uiWorkspace ? uiWorkspace.pickDirectory() : Promise.reject(new Error("没有可用的本地目录选择器"));
		}

		/**
		 * Register (or reuse) the local workspace that hosts this target's sessions,
		 * titled so the sidebar entry reads as a remote workspace. Returns its id.
		 */
		/**
		 * The Remote client wraps unary results as `{ ok, value }` (and failures as
		 * `{ ok: false, error }`), while other consumers hand back the payload
		 * directly. Normalize before reading, so either shape works.
		 */
		function unwrapRemote(result) {
			if (result && typeof result === "object" && "ok" in result) {
				if (result.ok === false) {
					const failure = result.error || {};
					throw new Error(failure.message || failure.code || "远程调用失败");
				}
				return result.value;
			}
			return result;
		}

		async function ensureRemoteWorkspace(sessionDir, name, host) {
			const workspaceRemote = service("remote.workspace");
			if (!workspaceRemote || typeof workspaceRemote.create !== "function") {
				throw new Error("当前组装没有 workspace 远程命名空间，无法创建工作区");
			}
			const created = unwrapRemote(await workspaceRemote.create({ path: sessionDir }));
			const workspaceId = created && created.workspace ? created.workspace.workspaceId : (created ? created.workspaceId : undefined);
			if (!workspaceId) throw new Error(`创建工作区没有返回 id（返回：${JSON.stringify(created)}）`);
			try {
				unwrapRemote(await workspaceRemote.rename({ workspaceId, title: `远程 · ${name || host} (${host})` }));
			} catch { /* a duplicate title is fine: the path-derived one stays */ }
			return workspaceId;
		}
		const CSS = `
.dshSsh_page{display:flex;flex-direction:column;gap:16px;padding:16px 24px;max-width:760px;font-size:13px;color:var(--dsw-alias-label-primary)}
.dshSsh_title{margin:0;font-size:16px;font-weight:510;line-height:24px}
.dshSsh_hint{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dshSsh_list{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.dshSsh_row{display:flex;flex-direction:column;gap:6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);padding:8px 10px}
.dshSsh_rowLine{display:flex;align-items:center;gap:10px}
.dshSsh_reveal{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshSsh_secret{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--dsw-alias-interactive-bg-hover);border-radius:var(--dsw-radius-sm);padding:2px 6px;color:var(--dsw-alias-label-primary);word-break:break-all}
.dshSsh_rowMain{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 auto}
.dshSsh_rowName{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshSsh_rowMeta{color:var(--dsw-alias-label-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshSsh_facts{display:flex;flex-direction:column;gap:2px}
.dshSsh_fact{display:flex;gap:8px;font-size:12px;align-items:baseline}
.dshSsh_factLabel{color:var(--dsw-alias-label-secondary);flex:0 0 68px}
.dshSsh_factValue{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-primary);word-break:break-all}
.dshSsh_badge{background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;padding:1px 8px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dshSsh_form{display:grid;grid-template-columns:120px 1fr;gap:8px 12px;align-items:center;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);padding:12px}
.dshSsh_label{color:var(--dsw-alias-label-secondary)}
.dshSsh_input{box-sizing:border-box;width:100%;height:28px;padding:3px 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-primary);font-size:13px;outline:none}
.dshSsh_inputRow{display:flex;gap:8px;align-items:center}
.dshSsh_actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dshSsh_btn{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-primary);cursor:pointer;padding:4px 12px;font-size:13px;height:28px}
.dshSsh_btn:hover:enabled{background:var(--dsw-alias-interactive-bg-hover)}
.dshSsh_btn:disabled{color:var(--dsw-alias-label-caption);cursor:default}
.dshSsh_primary{border-color:transparent;background:var(--dsw-alias-state-business-primary);color:#fff}
.dshSsh_ok{color:var(--dsw-alias-state-business-primary);font-size:12px}
.dshSsh_err{color:var(--dsw-alias-state-error-primary);font-size:12px}
.dshSsh_browser{display:flex;flex-direction:column;gap:8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);padding:12px;max-height:320px;overflow:auto}
.dshSsh_modal{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:60}
.dshSsh_card{background:var(--dsw-alias-bg-layer-2,#1c1c1e);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg,10px);padding:18px;display:flex;flex-direction:column;gap:14px;width:min(520px,92vw);max-height:86vh;overflow:auto}
`;

		const EMPTY_FORM = {
			id: "", target: "", name: "", host: "", port: "22", username: "",
			identityFile: "", passwordEnv: "", remoteDir: "", password: "",
		};

		async function api(path, init) {
			const response = await fetch(ROUTE + path, Object.assign({
				headers: { "content-type": "application/json" },
			}, init));
			const text = await response.text();
			let data;
			try { data = text ? JSON.parse(text) : {}; } catch { data = { ok: false, message: text }; }
			if (!response.ok || data.ok === false) throw new Error(data.message || `HTTP ${response.status}`);
			return data;
		}

		function errorText(error) {
			return error instanceof Error ? error.message : String(error);
		}

		// The connection fields are remembered between visits so a failed test or a
		// closed panel never forces the operator to retype them. The password is
		// deliberately excluded: it belongs in the credential store, not the page.
		const DRAFT_KEY = "dsh-remote-ssh-draft";
		const DRAFT_FIELDS = ["name", "host", "port", "username", "identityFile", "passwordEnv", "remoteDir"];

		function readDraft() {
			try {
				const raw = globalThis.localStorage && globalThis.localStorage.getItem(DRAFT_KEY);
				if (!raw) return null;
				const parsed = JSON.parse(raw);
				const draft = {};
				for (const key of DRAFT_FIELDS) if (typeof parsed[key] === "string") draft[key] = parsed[key];
				return draft;
			} catch {
				return null;
			}
		}

		function writeDraft(form) {
			try {
				const draft = {};
				for (const key of DRAFT_FIELDS) draft[key] = form[key] == null ? "" : String(form[key]);
				if (globalThis.localStorage) globalThis.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
			} catch { /* a draft is a convenience, never a requirement */ }
		}

		function draftForm() {
			// Connection fields are remembered, identity is not: "添加" must always
			// create a new target instead of overwriting the previous one.
			const draft = Object.assign({}, EMPTY_FORM, readDraft() || {});
			// Identity is not inherited: "添加" creates a new target (the host
			// reuses/creates an id), while the connection fields — name included —
			// come back so nothing has to be retyped.
			draft.id = "";
			draft.target = "";
			return draft;
		}

		/** Form state plus the test/save calls shared by the page and the flow. */
		function useTargetEditor() {
			const [form, setForm] = useState(draftForm);
			const [busy, setBusy] = useState(false);
			const [tested, setTested] = useState(false);
			const [okText, setOkText] = useState("");
			const [error, setError] = useState("");
			const [storePassword, setStorePassword] = useState(true);
			const [showPassword, setShowPassword] = useState(false);
			const [browsing, setBrowsing] = useState(false);
			const [listing, setListing] = useState(null);
			const [browseError, setBrowseError] = useState("");
			const [browsePath, setBrowsePath] = useState("");

			// matchSaved reads the live form through this ref, so it needs no deps.
			const currentRef = useRef(EMPTY_FORM);
			currentRef.current = form;
			const current = currentRef.current;

			const change = useCallback((name, value) => {
				setForm((current) => {
					const next = Object.assign({}, current, { [name]: value });
					if (name !== "password") writeDraft(next);
					return next;
				});
				if (name !== "password") setTested(false);
				setError("");
			}, []);

			const payload = useCallback(() => ({
				target: form.target || undefined,
				name: form.name, host: form.host,
				port: form.port === "" ? undefined : Number(form.port),
				username: form.username, identityFile: form.identityFile,
				passwordEnv: form.passwordEnv, remoteDir: form.remoteDir,
			}), [form]);

			const payloadWithPassword = useCallback(() => Object.assign(payload(), {
				password: form.password,
				storePassword,
			}), [payload, form.password, storePassword]);

			const start = (target) => {
				setBrowsing(false); setListing(null); setBrowseError("");
				if (target) {
					const filled = {
						id: target.id, target: target.id, name: target.name, host: target.host,
						port: String(target.port), username: target.username,
						identityFile: target.identityFile, passwordEnv: target.passwordEnv,
						remoteDir: target.remoteDir, localDir: target.localDir || "", password: "",
					};
					writeDraft(filled);
					setForm(filled);
					// Opening a saved target shows the password it saved, read back from
					// the credential store; the input stays masked until you click 显示.
					if (target.passwordEnv) {
						api("/reveal", { method: "POST", body: JSON.stringify({ target: target.id }) })
							.then((data) => setForm((current) => (current.id === target.id
								? Object.assign({}, current, { password: data.password || "" })
								: current)))
							.catch(() => { /* leave it blank; the list's 显示密码 still works */ });
					}
				} else {
					setForm(draftForm());
				}
				setTested(false); setOkText(""); setError(""); setStorePassword(true); setShowPassword(false);
			};

			const test = useCallback(async () => {
				setBusy(true); setError(""); setOkText("");
				try {
					const result = await api("/test", {
						method: "POST",
						body: JSON.stringify(Object.assign(payload(), { password: form.password })),
					});
					setTested(true);
					setOkText(result.message || "连接成功");
					return true;
				} catch (e) {
					setTested(false);
					setError(`连接测试失败：${errorText(e)}`);
					return false;
				} finally { setBusy(false); }
			}, [form.password, payload]);

			/** List a REMOTE directory over the target's own SSH connection. */
			const browseRemote = useCallback(async (path) => {
				setBusy(true); setBrowseError("");
				try {
					const data = await api("/list-dir", {
						method: "POST",
						body: JSON.stringify(Object.assign(payload(), { password: form.password, path: path || "" })),
					});
					setListing(data.listing || null);
					setBrowsePath(data.listing ? data.listing.path : path);
					return true;
				} catch (e) {
					setBrowseError(errorText(e));
					return false;
				} finally { setBusy(false); }
			}, [form.password, payload]);

			/**
			 * If the connection currently in the form matches a saved target, load
			 * that target's password from the credential store into the field. This
			 * is what stops "retype the password every time" — it works for 添加 as
			 * well as 编辑, because the match is by host/port/username.
			 */
			const matchSaved = useCallback(async (list) => {
				const form = current;
				const host = (form.host || "").trim();
				if (!host) return;
				const port = String(form.port === "" ? "22" : form.port);
				const username = (form.username || "").trim();
				const hit = (list || []).find((t) => t.host === host && String(t.port) === port && (t.username || "") === username);
				if (!hit || !hit.passwordEnv) return;
				if ((form.password || "") !== "") return; // never clobber what you typed
				try {
					const data = await api("/reveal", { method: "POST", body: JSON.stringify({ target: hit.id }) });
					setForm((cur) => ((cur.password || "") === "" && (cur.host || "").trim() === host
						? Object.assign({}, cur, { password: data.password || "" })
						: cur));
					setOkText(`已载入已保存目标「${hit.name}」的密码（点「显示」可核对）`);
				} catch { /* no stored password for that connection */ }
			}, []);

			const pickLocal = useCallback(async () => {
				try {
					const path = await pickLocalDirectory();
					if (path) setForm((current) => {
						const next = Object.assign({}, current, { localDir: path });
						writeDraft(next);
						return next;
					});
				} catch (e) {
					setError(`选择本地目录失败：${errorText(e)}`);
				}
			}, []);

			const save = useCallback(async (extra) => {
				setBusy(true); setError("");
				try {
					const result = await api("/targets", { method: "POST", body: JSON.stringify(Object.assign(payloadWithPassword(), extra || {})) });
					setOkText(result.message || "已保存");
					return result;
				} catch (e) {
					setError(`保存失败：${errorText(e)}`);
					return null;
				} finally { setBusy(false); }
			}, [payload]);

			return {
				form, change, start, test, save, busy, tested, okText, error, setError, setOkText,
				storePassword, setStorePassword, showPassword, setShowPassword,
				browsing, setBrowsing, listing, browseRemote, browseError, browsePath, setBrowsePath, pickLocal, matchSaved,
			};
		}

		function Field(props) {
			const { name, label, placeholder, type, value, onChange } = props;
			return [
				h("label", { key: `${name}-l`, className: "dshSsh_label", htmlFor: `dshSsh-${name}` }, label),
				h("input", {
					key: `${name}-i`, id: `dshSsh-${name}`, className: "dshSsh_input", type,
					placeholder, value, onChange: (event) => onChange(name, event.target.value),
				}),
			];
		}

		/** The remote directory browser (lists the REMOTE filesystem over SSH). */
		function RemoteDirBrowser(props) {
			const { editor } = props;
			const listing = editor.listing;
			const here = listing ? listing.path : (editor.form.remoteDir || "（远端 $HOME）");
			return h("div", { className: "dshSsh_browser" },
				h("div", { className: "dshSsh_inputRow" },
					h("input", {
						id: "dshSsh-browsePath", className: "dshSsh_input", type: "text",
						placeholder: "直接输入远端路径，例如 /srv/app",
						value: editor.browsePath === undefined ? (editor.form.remoteDir || "") : editor.browsePath,
						onChange: (event) => editor.setBrowsePath(event.target.value),
						onKeyDown: (event) => { if (event.key === "Enter") void editor.browseRemote(editor.browsePath || ""); },
					}),
					h("button", {
						type: "button", className: "dshSsh_btn", disabled: editor.busy,
						onClick: () => void editor.browseRemote(editor.browsePath || ""),
					}, "跳到"),
					h("button", {
						type: "button", className: "dshSsh_btn dshSsh_primary", disabled: editor.busy,
						onClick: () => { editor.change("remoteDir", (editor.browsePath || "").trim() || (listing ? listing.path : "")); editor.setBrowsing(false); },
					}, "用这个目录")),
				h("div", { className: "dshSsh_reveal" },
					h("span", null, "当前："),
					h("code", { className: "dshSsh_secret" }, here)),
				editor.browseError ? h("div", { className: "dshSsh_err" }, editor.browseError) : null,
				h("div", { className: "dshSsh_actions" },
					h("button", {
						type: "button", className: "dshSsh_btn", disabled: editor.busy,
						onClick: () => void editor.browseRemote(listing && listing.parent !== undefined ? listing.parent : editor.form.remoteDir),
					}, "上级目录"),
					h("button", { type: "button", className: "dshSsh_btn", disabled: editor.busy, onClick: () => void editor.browseRemote("") }, "$HOME"),
					h("button", {
						type: "button", className: "dshSsh_btn dshSsh_primary", disabled: editor.busy || !listing,
						onClick: () => { editor.change("remoteDir", listing.path); editor.setBrowsing(false); },
					}, "选择这个目录"),
					h("button", { type: "button", className: "dshSsh_btn", disabled: editor.busy, onClick: () => editor.setBrowsing(false) }, "取消")),
				h("ul", { className: "dshSsh_list" },
					(listing ? listing.entries : []).map((entry) => h("li", { key: entry.name, className: "dshSsh_row" },
						h("div", { className: "dshSsh_rowLine" },
							h("span", { className: "dshSsh_rowName" }, entry.dir ? `📁 ${entry.name}` : `📄 ${entry.name}`),
							entry.dir
								? h("button", {
									type: "button", className: "dshSsh_btn", disabled: editor.busy,
									onClick: () => void editor.browseRemote(`${listing.path.replace(/\/$/, "")}/${entry.name}`),
								}, "进入")
								: null)))),
				!listing && !editor.browseError ? h("div", { className: "dshSsh_hint" }, editor.busy ? "读取远端目录…" : "点「$HOME」或「上级目录」开始浏览") : null);
		}

		/** The seven target fields plus the one-off test password. */
		function TargetForm(props) {
			const { editor } = props;
			const wide = [
				["name", "名称", "例如 生产服务器", "text"],
				["host", "主机", "10.0.0.12 或 host.example.com", "text"],
				["port", "端口", "22", "number"],
				["username", "用户名", "留空则用 $USER", "text"],
				["identityFile", "私钥", "~/.ssh/id_ed25519", "text"],
				["passwordEnv", "密码环境变量", "REMOTE_SSH_PASSWORD（不保存密码本身）", "text"],
			];
			if (editor.browsing) return h("div", {}, RemoteDirBrowser({ editor }));
			return h("div", { className: "dshSsh_form" },
				wide.map(([name, label, placeholder, type]) => Field({
					name, label, placeholder, type, value: editor.form[name], onChange: editor.change,
				})),
				h("label", { className: "dshSsh_label", htmlFor: "dshSsh-remoteDir" }, "远程目录"),
				h("div", { className: "dshSsh_inputRow" },
					h("input", {
						id: "dshSsh-remoteDir", className: "dshSsh_input", type: "text",
						placeholder: "远端工作目录，例如 /root/财经",
						value: editor.form.remoteDir,
						onChange: (event) => editor.change("remoteDir", event.target.value),
					}),
					h("button", {
						type: "button", className: "dshSsh_btn", id: "dshSsh-browse",
						onClick: () => { editor.setBrowsing(true); void editor.browseRemote(editor.form.remoteDir || ""); },
					}, "浏览远端…")),

				h("label", { className: "dshSsh_label", htmlFor: "dshSsh-password" }, "密码"),
				h("div", { className: "dshSsh_inputRow" },
					h("input", {
						id: "dshSsh-password", className: "dshSsh_input",
						type: editor.showPassword ? "text" : "password",
						placeholder: "仅密码登录时填写；留空则用私钥 / ssh-agent",
						value: editor.form.password,
						onChange: (event) => editor.change("password", event.target.value),
					}),
					h("button", {
						type: "button", className: "dshSsh_btn", id: "dshSsh-togglePassword",
						title: editor.showPassword ? "隐藏密码" : "明文显示密码",
						onClick: () => editor.setShowPassword(!editor.showPassword),
					}, editor.showPassword ? "隐藏" : "显示")),
				h("div", { className: "dshSsh_hint" },
					h("label", { htmlFor: "dshSsh-storePassword", title: "保存后 ssh-exec 无需再带密码" },
						h("input", {
							id: "dshSsh-storePassword", type: "checkbox", checked: editor.storePassword,
							onChange: (event) => editor.setStorePassword(event.target.checked),
						}),
						"保存密码到 DSH 凭据库（之后可点「显示密码」随时查看）")));
		}

		function Messages(props) {
			return [
				props.error ? h("div", { key: "e", className: "dshSsh_err" }, props.error) : null,
				props.okText ? h("div", { key: "o", className: "dshSsh_ok" }, props.okText) : null,
			];
		}

		// ── Settings page ──────────────────────────────────────────────────────

		// ── Workspace directory flow (本地目录 | 远程 SSH) ──────────────────────

		/**
		 * Occupant of both directory-flow holes. Reports exactly one outcome per
		 * `open` edge: `onPicked` (local path), `onCancel` (dismissed), or
		 * `onError`. The remote branch saves the SSH target first and then adopts
		 * the optional local directory that hosts the session.
		 */
		/**
		 * Occupant of both directory-flow holes. Reports exactly one outcome per
		 * `open` edge: `onPicked` (a local path the owner adopts), `onCancel`, or
		 * `onError`. Three modes: choose a local directory, pick a SAVED remote
		 * workspace (and open it), or configure a new one.
		 */
		function RemoteWorkspaceFlow(props) {
			const { open, busy, onPicked, onCancel, onError } = props;
			const [mode, setMode] = useState("choose");
			const [homeDir, setHomeDir] = useState("");
			const [targets, setTargets] = useState([]);
			const [defaultId, setDefaultId] = useState("");
			const [revealed, setRevealed] = useState({});
			const [listError, setListError] = useState("");
			const editor = useTargetEditor();
			const armed = useRef(false);
			const alive = useRef(true);
			const latest = useRef(props);
			latest.current = props;

			useEffect(() => () => { alive.current = false; }, []);

			const loadTargets = useCallback(async () => {
				try {
					const data = await api("/targets");
					setTargets(data.targets || []);
					setDefaultId(data.defaultId || "");
					setHomeDir(data.homeDir || "");
					setListError("");
					return data;
				} catch (e) {
					setListError(errorText(e));
					return null;
				}
			}, []);

			useEffect(() => {
				if (!open) {
					armed.current = false;
					setMode("choose");
					setRevealed({});
					setListError("");
					editor.start(null);
					return;
				}
				if (armed.current) return;
				armed.current = true;
				void loadTargets();
			}, [open]);

			// Saved-password auto-fill for the connection currently in the form.
			useEffect(() => {
				if (mode === "form") void editor.matchSaved(targets);
			}, [mode, targets, editor.form.host, editor.form.port, editor.form.username]);

			const resolveOutcome = (path) => {
				if (!alive.current) return;
				if (path === null || path === undefined) latest.current.onCancel();
				else latest.current.onPicked(path);
			};

			const fail = (message) => {
				if (alive.current) latest.current.onError(message);
			};

			const chooseLocal = () => {
				Promise.resolve()
					.then(() => pickLocalDirectory())
					.then((path) => resolveOutcome(path), (reason) => fail(errorText(reason)));
			};

			/** A session needs a local cwd; the plugin uses the operator's home dir. */
			const sessionDir = async () => {
				if (homeDir) return homeDir;
				const data = await loadTargets();
				return (data && data.homeDir) || "";
			};

			/** Enter a SAVED remote workspace: make it the default, title its workspace, adopt it. */
			const openTarget = async (target) => {
				setListError("");
				try {
					await api("/default", { method: "POST", body: JSON.stringify({ target: target.id }) });
					setDefaultId(target.id);
					const dir = await sessionDir();
					if (!dir) throw new Error("拿不到本地主目录，无法建立会话");
					try {
						await ensureRemoteWorkspace(dir, target.name, target.host);
					} catch { /* the owner still adopts it, named from the path */ }
					resolveOutcome(dir);
				} catch (e) {
					setListError(`打开失败：${errorText(e)}`);
				}
			};

			const removeTarget = async (target) => {
				try {
					await api("/targets/delete", { method: "POST", body: JSON.stringify({ target: target.id }) });
					setRevealed({});
					await loadTargets();
				} catch (e) {
					setListError(`删除失败：${errorText(e)}`);
				}
			};

			const toggleReveal = async (target) => {
				if (revealed[target.id]) {
					const next = Object.assign({}, revealed);
					delete next[target.id];
					setRevealed(next);
					return;
				}
				try {
					const data = await api("/reveal", { method: "POST", body: JSON.stringify({ target: target.id }) });
					setRevealed(Object.assign({}, revealed, { [target.id]: data }));
				} catch (e) {
					setListError(`读取密码失败：${errorText(e)}`);
				}
			};

			const commitRemote = async () => {
				// Saving makes the new target the default, so the session that follows
				// actually talks to this host, and it opens right here.
				const result = await editor.save({ setDefault: true });
				if (!result) return;
				const dir = await sessionDir();
				if (!dir) {
					fail("拿不到本地主目录，无法建立会话工作区");
					return;
				}
				try {
					await ensureRemoteWorkspace(dir, editor.form.name || editor.form.host, editor.form.host);
				} catch { /* the owner still adopts and names it from the path */ }
				resolveOutcome(dir);
			};

			if (!open) return null;

			const fact = (label, value) => h("div", { className: "dshSsh_fact" },
				h("span", { className: "dshSsh_factLabel" }, label),
				h("code", { className: "dshSsh_factValue" }, value));

			const chooser = h(React.Fragment, null,
				h("p", { className: "dshSsh_hint" }, "选择本地目录，或进入/新建一个远程工作区。"),
				h("div", { className: "dshSsh_actions" },
					h("button", { type: "button", className: "dshSsh_btn", disabled: busy, onClick: chooseLocal }, "本地目录…"),
					h("button", {
						type: "button", className: "dshSsh_btn dshSsh_primary", id: "dshSsh-openRemote",
						disabled: busy, onClick: () => { setMode("list"); void loadTargets(); },
					}, targets.length > 0 ? `远程工作区（${targets.length}）…` : "远程工作区…"),
					h("button", { type: "button", className: "dshSsh_btn", disabled: busy, onClick: () => resolveOutcome(null) }, "取消")));

			const listPanel = h(React.Fragment, null,
				h("p", { className: "dshSsh_hint" }, "已保存的远程工作区：点「打开」直接进入（会设为默认），也可以编辑或删除。"),
				listError ? h("div", { className: "dshSsh_err" }, listError) : null,
				targets.length === 0
					? h("p", { className: "dshSsh_hint" }, "还没有保存过远程工作区，先新建一个。")
					: h("ul", { className: "dshSsh_list" }, targets.map((target) => {
						const secret = revealed[target.id];
						return h("li", { key: target.id, className: "dshSsh_row" },
							h("div", { className: "dshSsh_rowLine" },
								h("span", { className: "dshSsh_rowName" }, target.name),
								target.id === defaultId ? h("span", { className: "dshSsh_badge" }, "默认") : null,
								h("span", { className: "dshSsh_rowMeta" }, `${target.username || "$USER"}@${target.host}:${target.port}`),
								h("div", { className: "dshSsh_rowMain" }),
								target.passwordEnv
									? h("button", { type: "button", className: "dshSsh_btn", onClick: () => void toggleReveal(target) },
										secret ? "隐藏密码" : "显示密码")
									: null,
								h("button", { type: "button", className: "dshSsh_btn dshSsh_primary", onClick: () => void openTarget(target) }, "打开"),
								h("button", { type: "button", className: "dshSsh_btn", onClick: () => { editor.start(target); setMode("form"); } }, "编辑"),
								h("button", { type: "button", className: "dshSsh_btn", onClick: () => void removeTarget(target) }, "删除")),
							h("div", { className: "dshSsh_facts" },
								fact("远程目录", target.remoteDir || "（未设置）"),
								fact("密码", target.passwordEnv
									? ((target.hasStoredPassword || target.hasPasswordEnv) ? `已保存 · 引用 ${target.passwordEnv}` : `未保存 · 引用 ${target.passwordEnv}`)
									: "未保存（用私钥 / ssh-agent）")),
							secret ? h("div", { className: "dshSsh_reveal" },
								h("span", null, "密码："),
								h("code", { className: "dshSsh_secret" }, secret.password),
								h("span", null, `来源：${secret.source || "凭据库"}`)) : null);
					})),
				h("div", { className: "dshSsh_actions" },
					h("button", { type: "button", className: "dshSsh_btn dshSsh_primary", disabled: busy, onClick: () => { editor.start(null); setMode("form"); } }, "+ 新建远程工作区（SSH）…"),
					h("button", { type: "button", className: "dshSsh_btn", disabled: busy, onClick: () => setMode("choose") }, "返回")));

			const formPanel = h(React.Fragment, null,
				TargetForm({ editor }),
				h("div", { className: "dshSsh_hint" },
					"「远程目录」是**远程机器上的**工作目录，命令都在那里执行（可直接输入路径，或点「浏览远端…」选择）。"
					+ "保存后会立即设为默认，并在侧边栏生成/打开一个名为「远程 · 名称 (主机)」的工作区；会话的本地目录由插件自动使用你的主目录。"),
				Messages({ error: editor.error, okText: editor.okText }),
				h("div", { className: "dshSsh_actions" },
					h("button", { type: "button", className: "dshSsh_btn", disabled: editor.busy, onClick: () => void editor.test() },
						editor.busy ? "处理中…" : "测试连接"),
					h("button", { type: "button", className: "dshSsh_btn dshSsh_primary", disabled: editor.busy, onClick: () => void commitRemote() },
						editor.tested ? "保存并打开（已连通）" : "保存并打开"),
					h("button", { type: "button", className: "dshSsh_btn", disabled: editor.busy, onClick: () => { setMode(targets.length > 0 ? "list" : "choose"); editor.start(null); } }, "返回"),
					h("button", { type: "button", className: "dshSsh_btn", disabled: editor.busy, onClick: () => resolveOutcome(null) }, "取消")));

			return h("div", { className: "dshSsh_modal" },
				h("style", { "data-plugin-css": "dsh-remote-retry-llm-plugin/remote-workspace-flow" }, CSS),
				h("div", { className: "dshSsh_card" },
					h("h2", { className: "dshSsh_title" },
						mode === "form" ? (editor.form.id ? "编辑远程工作区" : "新建远程工作区（SSH）")
							: mode === "list" ? "选择远程工作区" : "添加工作区"),
					mode === "form" ? formPanel : mode === "list" ? listPanel : chooser));
		}

		// ── Registration ───────────────────────────────────────────────────────

		const inject = ["slots", "uiWorkspace"];

		function apply(ctx) {
			pluginCtx = ctx;
			const injected = () => ({ pick: pickLocalDirectory });

			// Priority -1: the slot renders the LOWEST priority, so this flow wins
			// over the shipped picker while it stays registered behind us.
			ctx.slots.inject("conversation.hero.workspace.directoryFlow", () => ctx.slots.inject("sidebar.workspaces.directoryFlow", function* () {
				yield ctx.slots.register({
					name: "conversation.hero.workspace.directoryFlow",
					priority: -1,
					inject: injected,
				}, RemoteWorkspaceFlow);
				yield ctx.slots.register({
					name: "sidebar.workspaces.directoryFlow",
					priority: -1,
					inject: injected,
				}, RemoteWorkspaceFlow);
			}));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});

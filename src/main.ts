/*
 * Scuttlebutt — an Obsidian plugin
 *
 * A local-first meeting companion that lives in your sidebar (inspired by anarlog):
 * record (or import) a meeting, transcribe it against your local Whisper/vLLM
 * server, auto-summarize it with your local LLM, review the Summary / Transcript /
 * Memo side-by-side, then save a single tidy note with a clean title and tags.
 *
 * Pipeline:  record | import  ->  transcribe  ->  summarize (+ title + tags)  ->  review  ->  save note
 *
 * Local-first. Everything runs against endpoints you configure. No cloud, no accounts.
 */

import { Notice, Platform, Plugin, TFile, normalizePath, requestUrl } from 'obsidian';
import {
	applyTemplate,
	calloutBlock,
	DEFAULT_REASONING_BUDGETS,
	errorMessage,
	extractAudioEmbeds,
	extractCallout,
	extractSummaryBody,
	fixMissingAudioDuration,
	formatDuration,
	isNewerVersion,
	isRecord,
	recordedMs,
	recordingStamp,
	sanitizeFileName,
	str,
	structureSummary,
	todayStamp,
	yamlString,
} from './utils';
import {
	AudioSegment,
	DEFAULT_DATE_FORMAT,
	DEFAULT_FILENAME_TEMPLATE,
	DEFAULT_SETTINGS,
	MeetingSession,
	mmt,
	newSession,
	ScuttlebuttSettings,
	SessionStatus,
	VIEW_TYPE_SCUTTLEBUTT,
} from './types';
import { MeetingRecorder } from './recorder';
import { AIService } from './ai';
import { ScuttlebuttView } from './view';
import { ScuttlebuttSettingTab } from './settings-tab';

// API keys live in Obsidian's secret storage (OS keychain), not data.json.
const STT_KEY_ID = 'scuttlebutt-stt-api-key';
const LLM_KEY_ID = 'scuttlebutt-llm-api-key';

export default class ScuttlebuttPlugin extends Plugin {
	declare settings: ScuttlebuttSettings;
	session: MeetingSession = newSession();
	recorder = new MeetingRecorder();
	ai!: AIService;
	private statusBarEl: HTMLElement | null = null;
	private statusBarTimer: number | null = null;
	// In-flight transcription/summary request, so the user can cancel it. Each run owns
	// its own AbortController; catch handlers classify a user abort via controller.signal.aborted.
	private activeController: AbortController | null = null;
	private startingRecording = false;
	// Guards against stop() running twice concurrently: a device can expose more than one
	// audio track (e.g. stereo captured as two mono tracks), each with its own 'ended'
	// listener (see recorder.ts) — a real disconnect can fire more than one of those at
	// once, each independently calling stopRecording(). Without this, the second call
	// would race the first: recorder.stop() resolves with an empty blob once the recorder
	// has already been torn down, showing a spurious "Recording was empty" right after a
	// perfectly good segment was just captured.
	private stoppingRecording = false;
	// Audio files embedded in the current non-Scuttlebutt active note, if any — kept in
	// sync via the file-open handler below, so renderCapture() can show the "This note's
	// audio" button without doing an async file read on every render.
	activeNoteAudioFiles: TFile[] = [];
	// Cleared if secret storage is unavailable, so we fall back to keeping the keys
	// in data.json rather than losing them.
	private secretStorageOk = true;

	/** True while a transcription, summary, or save is running. */
	isBusy(): boolean {
		const st = this.session.status;
		return st === 'transcribing' || st === 'summarizing' || st === 'saving';
	}

	async onload(): Promise<void> {
		await this.loadSettings();
		// The initial session was field-initialised before settings loaded — seed its run
		// options from the settings now so the first recording reflects the configured defaults.
		this.session.diarize = this.settings.sttDiarize;
		this.session.reasoningEffort = this.settings.reasoningEffort;
		this.session.stream = this.settings.streamSummary;

		this.registerView(VIEW_TYPE_SCUTTLEBUTT, (leaf) => new ScuttlebuttView(leaf, this));
		this.addRibbonIcon('mic', 'Scuttlebutt', () => this.ribbonClicked());

		this.recorder.onUnexpectedEnd = (trackLabel) => {
			new Notice(
				`Mic connection dropped during recording (${trackLabel}). ` +
					'The rest of this recording is empty — press Stop and try "Add recording" again.',
				12000
			);
			void this.stopRecording();
		};

		this.addCommand({ id: 'open-sidebar', name: 'Open sidebar', callback: () => this.activateView() });
		this.addCommand({
			id: 'link-active-note',
			name: 'Link current note to Scuttlebutt',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				const can = !!file && file.extension === 'md' && !this.recorder.isActive() && !this.isBusy();
				if (can && !checking) void this.linkActiveNote();
				return can;
			},
		});
		this.addCommand({
			id: 'toggle-recording',
			name: 'Start / stop recording',
			callback: () => this.ribbonClicked(),
		});
		this.addCommand({
			id: 'toggle-pause',
			name: 'Pause / resume recording',
			checkCallback: (checking) => {
				const can = this.recorder.isActive();
				if (can && !checking) this.togglePause();
				return can;
			},
		});
		this.addCommand({
			id: 'process-recording',
			name: 'Transcribe & summarize current recording',
			checkCallback: (checking) => {
				const can = this.session.segments.length > 0 && !this.isBusy();
				if (can && !checking) void this.runPipeline();
				return can;
			},
		});
		this.addCommand({
			id: 'save-note',
			name: 'Save meeting note',
			checkCallback: (checking) => {
				const can = !!(this.session.summary || this.session.transcript) && !this.isBusy();
				if (can && !checking) void this.saveNote();
				return can;
			},
		});

		this.addSettingTab(new ScuttlebuttSettingTab(this.app, this));

		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass('mh-statusbar', 'mh-hidden');

		// Check for a newer release once the workspace is ready (non-blocking, throttled).
		this.app.workspace.onLayoutReady(() => void this.maybeCheckForUpdate());

		// Reading View and Live Preview render `![[...]]` audio embeds through entirely
		// different internal paths — a markdown post-processor only covers Reading View.
		// A single long-lived observer on the whole workspace catches <audio> elements
		// regardless of which view (or future view) put them there.
		const audioObserver = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				mutation.addedNodes.forEach((node) => {
					if (!(node instanceof HTMLElement)) return;
					if (node.tagName === 'AUDIO') fixMissingAudioDuration(node as HTMLAudioElement);
					node.querySelectorAll?.('audio').forEach((el) => fixMissingAudioDuration(el));
				});
			}
		});
		audioObserver.observe(document.body, { childList: true, subtree: true });
		this.register(() => audioObserver.disconnect());

		// file-open only fires on navigation — if a note was already active before the
		// plugin (re)loaded, it never fires for that note at all. Check once explicitly,
		// after the workspace has finished restoring, so "This note's audio" and the
		// auto-load-on-open behavior both work immediately without requiring a manual
		// switch away and back.
		this.app.workspace.onLayoutReady(async () => {
			const initialFile = this.app.workspace.getActiveFile();
			if (!initialFile) return;
			if (this.isScuttlebuttNote(initialFile)) {
				await this.loadNoteIntoSession(initialFile);
			} else {
				this.activeNoteAudioFiles = await this.findEmbeddedAudioFiles(initialFile);
				this.refreshViews();
			}
		});

		// Auto-load an existing Scuttlebutt note when it's opened, so the sidebar acts
		// as a properties panel for whichever such note is active — no separate command.
		this.registerEvent(
			this.app.workspace.on('file-open', async (file) => {
				if (this.recorder.isActive() || this.isBusy() || !file) return;
				if (file.path === this.session.savedNotePath) return;
				if (this.isScuttlebuttNote(file)) {
					await this.loadNoteIntoSession(file);
					this.activeNoteAudioFiles = [];
				} else {
					if (this.session.savedNotePath) {
						// Navigated away from a finished (already-saved) meeting to an
						// unrelated note — clear the stale session instead of leaving old
						// data on display.
						this.resetSession();
					}
					this.activeNoteAudioFiles = await this.findEmbeddedAudioFiles(file);
					this.refreshViews();
				}
			})
		);
	}

	onunload(): void {
		this.recorder.abort();
		this.stopStatusBarTimer();
	}

	async loadSettings(): Promise<void> {
		const saved = (await this.loadData()) as Partial<ScuttlebuttSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
		// reasoningBudgets is a nested object: clone the defaults and merge any saved
		// values so editing it never mutates DEFAULT_SETTINGS, and older data (missing
		// some levels) still gets every level filled in.
		this.settings.reasoningBudgets = Object.assign(
			{},
			DEFAULT_REASONING_BUDGETS,
			saved?.reasoningBudgets
		);
		// API keys live in secret storage. Load them into the in-memory settings (which
		// AIService reads), migrating any plaintext key left in data.json by older versions.
		let migrated = false;
		const loadKey = (id: string, plaintext: string): string => {
			try {
				const secret = this.app.secretStorage.getSecret(id);
				if (secret !== null) return secret;
				if (plaintext) {
					this.app.secretStorage.setSecret(id, plaintext);
					migrated = true;
				}
				return plaintext;
			} catch {
				this.secretStorageOk = false;
				return plaintext;
			}
		};
		this.settings.sttApiKey = loadKey(STT_KEY_ID, this.settings.sttApiKey);
		this.settings.llmApiKey = loadKey(LLM_KEY_ID, this.settings.llmApiKey);
		this.ai = new AIService(this.settings);
		// Re-save once after a migration so the plaintext key is scrubbed from data.json.
		if (migrated && this.secretStorageOk) await this.saveSettings();
	}

	async saveSettings(): Promise<void> {
		// Persist only. AIService holds `settings` by reference (mutated in place), so it needs
		// no rebuild; and the sidebar reads session state, not settings, so no re-render is
		// needed here. Re-rendering per keystroke rebuilt the audio Blob and reset playback.
		// API keys are blanked before persisting so they never touch data.json (unless secret
		// storage is unavailable, in which case we keep them to avoid data loss).
		const data: ScuttlebuttSettings = this.secretStorageOk
			? { ...this.settings, sttApiKey: '', llmApiKey: '' }
			: this.settings;
		await this.saveData(data);
	}

	/** Store an API key in secret storage and mirror it into the in-memory settings. */
	setApiKey(which: 'stt' | 'llm', value: string): void {
		const id = which === 'stt' ? STT_KEY_ID : LLM_KEY_ID;
		if (which === 'stt') this.settings.sttApiKey = value;
		else this.settings.llmApiKey = value;
		try {
			this.app.secretStorage.setSecret(id, value);
		} catch {
			this.secretStorageOk = false;
		}
	}

	/**
	 * Ask GitHub for the latest release at most once a day, remember it, and — if it
	 * is newer than the installed version — show a one-time notice. Silent on failure;
	 * a missed check should never nag. Skipped entirely when the user opts out.
	 */
	async maybeCheckForUpdate(): Promise<void> {
		const s = this.settings;
		if (!s.updateCheckEnabled) return;
		const DAY_MS = 24 * 60 * 60 * 1000;
		if (Date.now() - s.lastUpdateCheck >= DAY_MS) {
			s.lastUpdateCheck = Date.now();
			await this.saveSettings();
			try {
				const res = await requestUrl({
					url: 'https://api.github.com/repos/qkm2000/Scuttlebutt/releases/latest',
					headers: { Accept: 'application/vnd.github+json' },
					throw: false,
				});
				const data: unknown = res.json;
				if (isRecord(data)) {
					const tag = str(data.tag_name).replace(/^v/i, '').trim();
					if (tag) {
						s.latestKnownVersion = tag;
						await this.saveSettings();
					}
				}
			} catch {
				// network or parse failure — stay quiet
			}
		}
		this.notifyIfUpdate();
	}

	/** Show an update notice with a jump-to-update action, if a newer version is known. */
	private notifyIfUpdate(): void {
		const latest = this.settings.latestKnownVersion;
		if (!latest || !isNewerVersion(latest, this.manifest.version)) return;
		const frag = createFragment((f) => {
			f.appendText(`Scuttlebutt ${latest} is available (you have ${this.manifest.version}). `);
			const link = f.createEl('a', { text: 'Update', href: '#' });
			link.addEventListener('click', (e) => {
				e.preventDefault();
				this.openCommunityPlugins();
			});
		});
		new Notice(frag, 15000);
	}

	/** Open Settings -> Community plugins so the user can update from there. */
	openCommunityPlugins(): void {
		const setting = (
			this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }
		).setting;
		setting?.open();
		setting?.openTabById('community-plugins');
	}

	async activateView(): Promise<void> {
		try {
			const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_SCUTTLEBUTT);
			if (existing.length > 0) {
				await this.app.workspace.revealLeaf(existing[0]);
				return;
			}
			const leaf = this.app.workspace.getRightLeaf(false);
			if (!leaf) {
				new Notice('Could not open the Scuttlebutt sidebar.');
				return;
			}
			await leaf.setViewState({ type: VIEW_TYPE_SCUTTLEBUTT, active: true });
			await this.app.workspace.revealLeaf(leaf);
		} catch (err) {
			console.error('Scuttlebutt: failed to open sidebar', err);
			new Notice('Failed to open sidebar: ' + errorMessage(err));
		}
	}

	getViews(): ScuttlebuttView[] {
		return this.app.workspace
			.getLeavesOfType(VIEW_TYPE_SCUTTLEBUTT)
			.map((leaf) => leaf.view)
			.filter((v): v is ScuttlebuttView => v instanceof ScuttlebuttView);
	}

	refreshViews(): void {
		for (const view of this.getViews()) view.render();
	}

	/**
	 * A new empty session that inherits the current session's run options (speakers /
	 * thinking / streaming). Used when a recording or import begins, so choices made after
	 * "New" persist into the run instead of being reset to the global defaults.
	 */
	private freshSession(): MeetingSession {
		const s = this.session;
		const next = newSession(s.diarize, s.reasoningEffort, s.stream);
		// An explicit "From note" binding (see linkActiveNote) is a standing choice for
		// this meeting — it survives into the next recording/import, not just the first
		// one, until the user starts a genuinely new, unbound meeting or links elsewhere.
		// But a binding that only exists because an old note was passively opened for
		// viewing (loadedFromNote) is not that choice — it shouldn't carry forward either.
		if (s.foreignNote && s.savedNotePath && !s.loadedFromNote) {
			next.foreignNote = true;
			next.savedNotePath = s.savedNotePath;
		}
		return next;
	}

	/**
	 * Bind the currently active note as this session's save target before any audio
	 * exists yet — e.g. a handwritten note you're about to also record for. Whatever you
	 * record, or import via "From vault"/"Upload", afterward merges into that note
	 * through the same marked-block mechanism as "This note's audio", leaving the rest of
	 * what you wrote untouched.
	 */
	async linkActiveNote(): Promise<void> {
		if (this.recorder.isActive() || this.isBusy()) return;
		const file = this.app.workspace.getActiveFile();
		if (!file || file.extension !== 'md') {
			new Notice('Open the note you want to link first.');
			return;
		}
		if (this.isScuttlebuttNote(file)) {
			new Notice('This is already a Scuttlebutt note — just record or add audio normally.');
			return;
		}
		if (
			(this.session.summary || this.session.transcript || this.session.segments.length > 0) &&
			!this.session.loadedFromNote
		) {
			new Notice('Finish or clear the current meeting first ("New").');
			return;
		}
		this.session.savedNotePath = file.path;
		this.session.foreignNote = true;
		this.refreshViews();
		new Notice('Linked to: ' + file.basename);
	}

	/** Push streaming summary/reasoning into open views in place (no full re-render). */
	private updateStreamingViews(): void {
		for (const view of this.getViews()) view.updateStreaming();
	}

	private setStatus(status: SessionStatus): void {
		this.session.status = status;
	}

	private setProgress(label: string, pct: number): void {
		this.session.progressLabel = label;
		this.session.progressPct = pct;
	}

	// ---- recording -------------------------------------------------------

	async toggleRecording(): Promise<void> {
		if (this.recorder.isRecording()) {
			await this.stopRecording();
		} else {
			await this.startRecording();
		}
	}

	/**
	 * Ribbon icon / "toggle-recording" command: one click should always do something
	 * useful — start a fresh recording, add a take to an already-reviewed meeting, or
	 * stop whichever of those is running. Never just open the sidebar with no action,
	 * since that's already reachable without the ribbon icon at all.
	 */
	async ribbonClicked(): Promise<void> {
		if (this.recorder.isActive()) {
			await this.stopRecording();
		} else if ((this.session.summary || this.session.transcript) && !this.session.loadedFromNote) {
			await this.addRecording();
		} else {
			await this.startRecording();
		}
	}

	async startRecording(): Promise<void> {
		// Synchronous guard: a second call (double-click, ribbon + command) before the first
		// resolves would start a concurrent recorder and orphan the first mic stream.
		if (this.recorder.isActive() || this.startingRecording) return;
		this.startingRecording = true;
		try {
		if (this.session.status !== 'idle' && this.session.status !== 'error') {
			// Fresh recording starts a fresh session unless there is unsaved review content.
			// A note that was merely opened for viewing (loadedFromNote) is already fully
			// saved — nothing is at risk, so let a fresh recording proceed over it.
			if ((this.session.summary || this.session.transcript) && !this.session.loadedFromNote) {
				new Notice('Finish or clear the current meeting first ("New"), or use "Add recording" to extend it.');
				await this.activateView();
				return;
			}
		}
		let result: { systemAudio: boolean };
		try {
			result = await this.recorder.start({
				inputDeviceId: this.settings.inputDeviceId,
				systemAudioDeviceId: this.settings.systemAudioDeviceId,
				captureSystemAudio: this.settings.captureSystemAudio,
			});
		} catch (err) {
			new Notice('Microphone access failed: ' + errorMessage(err));
			return;
		}
		if ((this.settings.systemAudioDeviceId || this.settings.captureSystemAudio) && !result.systemAudio) {
			new Notice(
				'System audio could not be captured — recording microphone only. ' +
					'On macOS, install a loopback device (e.g. BlackHole) and pick it as the ' +
					'System audio device in Settings → Capture.',
				8000
			);
		}
		this.session = this.freshSession();
		this.session.activeMs = 0;
		this.session.segmentStartedAt = Date.now();
		this.session.paused = false;
		this.setStatus('recording');
		this.startStatusBarTimer();
		await this.activateView();
		this.refreshViews();
		if (!this.session.foreignNote) {
			// Create the note file right away, before any audio exists — so it shows up in
			// the vault immediately, and the recording is added into this same note once it
			// finishes, rather than the note only coming into being once you stop.
			try {
				this.session.savedNotePath = await this.writeNote();
				if (this.settings.autoOpenNote) {
					// New leaf, not the active one — so whatever you already had open (e.g. a
					// note you were reading) isn't replaced out from under you; matches the
					// same auto-open behavior used elsewhere (syncNote).
					await this.revealOrOpenNote(this.session.savedNotePath);
				}
			} catch (err) {
				console.warn('Scuttlebutt: could not pre-create the note', err);
			}
		}
		} finally {
			this.startingRecording = false;
		}
	}

	/**
	 * Record another take into the current meeting (e.g. after a break, or once it's
	 * already been transcribed/summarized/saved) without discarding what's there.
	 * Distinct from togglePause(), which only covers a brief pause *within* one take.
	 */
	async addRecording(): Promise<void> {
		if (this.recorder.isActive() || this.startingRecording) return;
		this.startingRecording = true;
		try {
			// Accidentally hit "Stop"? Don't force a wait for the transcript/summary of
			// that clip to finish — cancel it and go straight into the next recording
			// instead. But whatever's already done (e.g. the transcript, even if the
			// *summary* didn't finish) must be saved first — deterministically, before
			// touching the mic again, not left to race against finishCancelled().
			if (this.isBusy()) {
				this.cancelActive();
				if (this.session.transcript.trim() || this.session.summary.trim()) {
					await this.syncNote();
				}
			}
			let result: { systemAudio: boolean };
			try {
				result = await this.recorder.start({
					inputDeviceId: this.settings.inputDeviceId,
					systemAudioDeviceId: this.settings.systemAudioDeviceId,
					captureSystemAudio: this.settings.captureSystemAudio,
				});
			} catch (err) {
				new Notice('Microphone access failed: ' + errorMessage(err));
				return;
			}
			if ((this.settings.systemAudioDeviceId || this.settings.captureSystemAudio) && !result.systemAudio) {
				new Notice(
					'System audio could not be captured — recording microphone only. ' +
						'On macOS, install a loopback device (e.g. BlackHole) and pick it as the ' +
						'System audio device in Settings → Capture.',
					8000
				);
			}
			this.session.activeMs = 0;
			this.session.segmentStartedAt = Date.now();
			this.session.paused = false;
			this.setStatus('recording');
			this.startStatusBarTimer();
			await this.activateView();
			this.refreshViews();
		} finally {
			this.startingRecording = false;
		}
	}

	async stopRecording(): Promise<void> {
		if (!this.recorder.isActive() || this.stoppingRecording) return;
		this.stoppingRecording = true;
		try {
		// MediaRecorder only delivers its first chunk after ~1s; stopping before that
		// always yields an empty clip. Wait out the remainder rather than let that read
		// as a mysterious bug.
		const elapsedSoFar =
			this.session.activeMs + (this.session.segmentStartedAt ? Date.now() - this.session.segmentStartedAt : 0);
		const MIN_RECORDING_MS = 1200;
		if (elapsedSoFar < MIN_RECORDING_MS) {
			await new Promise((r) => window.setTimeout(r, MIN_RECORDING_MS - elapsedSoFar));
		}
		const now = Date.now();
		if (this.session.segmentStartedAt !== null) {
			this.session.activeMs += now - this.session.segmentStartedAt;
			this.session.segmentStartedAt = null;
		}
		this.session.paused = false;
		this.session.elapsedMs = this.session.activeMs;
		const blob = await this.recorder.stop();
		this.stopStatusBarTimer();
		if (blob.size === 0) {
			new Notice('Recording was empty.');
			this.setStatus(this.session.segments.length > 0 ? (this.session.summary ? 'ready' : 'recorded') : 'idle');
			this.refreshViews();
			return;
		}
		const segment: AudioSegment = {
			id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
			audioData: await blob.arrayBuffer(),
			audioMime: this.recorder.getMimeType(),
			audioName: `recording ${todayStamp(new Date())} ${formatDuration(this.session.elapsedMs)}.webm`,
			audioSourcePath: null,
			transcript: '',
		};
		this.session.segments.push(segment);
		this.setStatus('recorded');
		this.refreshViews();
		// Persist the raw audio to the note right away, before transcription/summary even
		// start — so a crash, cancellation, or Obsidian restart during processing can never
		// lose the recording itself, only (at worst) having to redo transcription.
		await this.syncNote();
		new Notice('Recording saved. Transcribing…');
		void this.runPipeline();
		} finally {
			this.stoppingRecording = false;
		}
	}

	togglePause(): void {
		if (!this.recorder.isActive()) return;
		const now = Date.now();
		if (this.session.paused) {
			this.recorder.resume();
			this.session.segmentStartedAt = now;
			this.session.paused = false;
		} else {
			this.recorder.pause();
			if (this.session.segmentStartedAt !== null) {
				this.session.activeMs += now - this.session.segmentStartedAt;
				this.session.segmentStartedAt = null;
			}
			this.session.paused = true;
		}
		this.refreshViews();
	}

	// ---- import ----------------------------------------------------------

	async importFromVault(file: TFile): Promise<void> {
		try {
			// If the currently open note already embeds this exact audio file, treat that
			// as "Scuttlebutt-ify this note" — write the result into it in place, instead
			// of creating a new note with today's date. A note that doesn't reference this
			// audio at all gets the normal fresh-note behavior, so this can't silently
			// overwrite an unrelated open note.
			const boundNotePath = await this.findNoteEmbedding(file);

			const data = await this.app.vault.readBinary(file);
			this.session = this.freshSession();
			this.session.savedNotePath = boundNotePath;
			this.session.foreignNote = !!boundNotePath;
			const segment: AudioSegment = {
				id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				audioData: data,
				audioMime: this.mimeForExtension(file.extension),
				audioName: file.name,
				audioSourcePath: file.path,
				transcript: '',
			};
			this.session.segments.push(segment);
			this.setStatus('recorded');
			this.refreshViews();
			if (boundNotePath) new Notice('Existing note detected — result will be added to: ' + boundNotePath);
			void this.runPipeline();
		} catch (err) {
			new Notice('Could not read audio file: ' + errorMessage(err));
		}
	}

	async importFromDisk(file: File): Promise<void> {
		try {
			const data = await file.arrayBuffer();
			this.session = this.freshSession();
			const segment: AudioSegment = {
				id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				audioData: data,
				audioMime: file.type || this.mimeForExtension(file.name.split('.').pop() ?? ''),
				audioName: file.name,
				audioSourcePath: null,
				transcript: '',
			};
			this.session.segments.push(segment);
			this.setStatus('recorded');
			await this.activateView();
			this.refreshViews();
			void this.runPipeline();
		} catch (err) {
			new Notice('Could not read audio file: ' + errorMessage(err));
		}
	}

	/**
	 * macOS-only: load or unload another local LaunchAgent-managed service by its label,
	 * via `launchctl`. Used to free up its GPU memory around a batch of LLM calls when
	 * running both at once would otherwise exceed the machine's unified-memory ceiling
	 * (see unloadServiceBeforeLLM in Settings). Failures are logged, never thrown — a
	 * service already in the target state, or a launchctl quirk, shouldn't block
	 * transcription or summarization.
	 *
	 * Node/Electron APIs don't exist on mobile and merely referencing them can crash the
	 * plugin there — so the Platform check must happen, and return, before either
	 * require() call below is ever reached, not just before the setting is honored.
	 */
	private async toggleLaunchAgent(action: 'load' | 'unload', label: string): Promise<void> {
		if (!Platform.isDesktop) return;
		const trimmedLabel = label.trim();
		if (!trimmedLabel) return;
		// eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef -- lazy desktop-only Node import, reached only after the Platform check above
		const { execFile } = require('child_process') as typeof import('child_process');
		// eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef -- lazy desktop-only Node import, reached only after the Platform check above
		const { homedir } = require('os') as typeof import('os');
		const plistPath = `${homedir()}/Library/LaunchAgents/${trimmedLabel}.plist`;
		await new Promise<void>((resolve) => {
			execFile('launchctl', [action, plistPath], (err, _stdout, stderr) => {
				if (err) {
					console.warn(`Scuttlebutt: launchctl ${action} failed for "${trimmedLabel}"`, stderr || err.message);
				}
				resolve();
			});
		});
		if (action === 'unload') {
			// Give macOS a moment to actually reclaim the freed Metal memory before the
			// next request tries to allocate against it.
			await new Promise((r) => window.setTimeout(r, 1500));
		}
	}

	private mimeForExtension(ext: string): string {
		const map: Record<string, string> = {
			webm: 'audio/webm',
			mp3: 'audio/mpeg',
			mpga: 'audio/mpeg',
			wav: 'audio/wav',
			m4a: 'audio/mp4',
			mp4: 'audio/mp4',
			ogg: 'audio/ogg',
			oga: 'audio/ogg',
			flac: 'audio/flac',
			aac: 'audio/aac',
		};
		return map[ext.toLowerCase()] ?? 'application/octet-stream';
	}

	/** All audio files this note embeds, resolved to real vault files (missing links are skipped). */
	private async findEmbeddedAudioFiles(note: TFile): Promise<TFile[]> {
		if (note.extension !== 'md') return [];
		const content = await this.app.vault.cachedRead(note);
		const files: TFile[] = [];
		for (const link of extractAudioEmbeds(content)) {
			const resolved = this.app.metadataCache.getFirstLinkpathDest(link, note.path);
			if (resolved) files.push(resolved);
		}
		return files;
	}

	private async findNoteEmbedding(audioFile: TFile): Promise<string | null> {
		const active = this.app.workspace.getActiveFile();
		if (!active) return null;
		const embedded = await this.findEmbeddedAudioFiles(active);
		return embedded.some((f) => f.path === audioFile.path) ? active.path : null;
	}

	/** True for a note bearing our own `scuttlebutt: true` frontmatter flag. */
	private isScuttlebuttNote(file: TFile): boolean {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		return fm?.scuttlebutt === true;
	}

	/** Load an already-saved Scuttlebutt note back into the session, so the sidebar acts
	 * as a live properties panel for whichever such note is currently open. */
	private async loadNoteIntoSession(file: TFile): Promise<void> {
		const content = await this.app.vault.read(file);
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		const fmEnd = content.indexOf('\n---', 3);
		const fullBody = fmEnd === -1 ? content : content.slice(fmEnd + 4).trim();

		// A note we merged into (rather than created) keeps its own content around our
		// marked block — only parse summary/transcript/memo from inside that block, but
		// still scan the whole file for audio embeds, since those live wherever the user
		// originally put them.
		const markerRe = /<!--scuttlebutt:start-->\n([\s\S]*?)\n<!--scuttlebutt:end-->/;
		const markerMatch = fullBody.match(markerRe);
		const isForeign = !!markerMatch;
		const body = markerMatch ? markerMatch[1] : fullBody;

		const s = newSession(this.settings.sttDiarize, this.settings.reasoningEffort, this.settings.streamSummary);
		s.foreignNote = isForeign;
		s.title = file.basename.replace(/^\d{4}-\d{2}-\d{2}[ -]+/, '');
		s.tags = Array.isArray(fm.tags) ? fm.tags.map(String) : [];
		s.participants = Array.isArray(fm.participants) ? fm.participants.map(String) : [];

		for (const link of extractAudioEmbeds(fullBody)) {
			const target = this.app.metadataCache.getFirstLinkpathDest(link, file.path);
			s.segments.push({
				id: target?.path ?? link,
				audioData: null,
				audioMime: target ? this.mimeForExtension(target.extension) : 'audio/webm',
				audioName: target?.name ?? link,
				audioSourcePath: target?.path ?? link,
				transcript: '',
			});
		}

		const transcript = extractCallout(body, 'note', 'Transcript') ?? '';
		if (s.segments.length > 0) {
			// The combined transcript is segments joined by "\n\n---\n\n" (see
			// transcribeStep) — split back along that same separator so each segment
			// keeps its own text where possible.
			const chunks = transcript.split(/\n\n---\n\n/);
			if (chunks.length === s.segments.length) {
				s.segments.forEach((seg, i) => (seg.transcript = chunks[i]));
			} else if (s.segments.length > 0) {
				s.segments[s.segments.length - 1].transcript = transcript;
			}
		}
		s.transcript = transcript;

		const memo = extractCallout(body, 'quote', 'Memo');
		if (memo) s.memo = memo;
		s.summary = extractSummaryBody(body);

		s.savedNotePath = file.path;
		s.status = s.summary ? 'ready' : s.segments.length > 0 ? 'recorded' : 'idle';
		s.loadedFromNote = true;
		this.session = s;
		this.refreshViews();
	}

	/** "This note's audio": transcribe + summarize every audio file the active note already
	 * embeds, merging the result into a marked block instead of touching anything else
	 * the user wrote in that note. */
	async scuttlebuttifyActiveNote(): Promise<void> {
		if (this.recorder.isActive()) return;
		const file = this.app.workspace.getActiveFile();
		if (!file || this.activeNoteAudioFiles.length === 0) {
			new Notice('No audio embedded in the current note.');
			return;
		}
		this.session = newSession(this.settings.sttDiarize, this.settings.reasoningEffort, this.settings.streamSummary);
		this.session.savedNotePath = file.path;
		this.session.foreignNote = true;

		for (const audioFile of this.activeNoteAudioFiles) {
			this.session.segments.push({
				id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				audioData: null,
				audioMime: this.mimeForExtension(audioFile.extension),
				audioName: audioFile.name,
				audioSourcePath: audioFile.path,
				transcript: '',
			});
		}

		this.setStatus('recorded');
		this.refreshViews();
		new Notice(`Transcribing ${this.session.segments.length} recording(s) from this note…`);
		void this.runAllSegmentsThenSummarize();
	}

	/** Transcribe every not-yet-transcribed segment in order, then summarize once at the end. */
	private async runAllSegmentsThenSummarize(): Promise<void> {
		while (this.session.segments.some((seg) => !seg.transcript.trim())) {
			const ok = await this.transcribeStep();
			if (!ok) return;
		}
		if (this.settings.autoSummarize && this.settings.llmEndpoint && this.settings.llmModel) {
			await this.summarizeInternal();
		} else {
			this.setStatus('recorded');
			this.session.activeTab = 'transcript';
			this.refreshViews();
			await this.syncNote();
		}
	}

	// ---- pipeline --------------------------------------------------------

	async runPipeline(): Promise<void> {
		if (this.isBusy()) {
			new Notice('A transcription or summary is already running.');
			return;
		}
		const ok = await this.transcribeStep();
		if (!ok) return;

		// Summarize (+ title + tags), if enabled and configured.
		if (this.settings.autoSummarize && this.settings.llmEndpoint && this.settings.llmModel) {
			await this.summarizeInternal();
		} else {
			const s = this.session;
			this.setStatus('recorded');
			this.setProgress('Transcript ready. Review, then summarize when ready.', 100);
			s.activeTab = 'transcript';
			this.refreshViews();
			await this.syncNote();
			window.setTimeout(() => this.clearProgressIfIdle(), 4000);
		}
	}

	/** Re-run transcription on the most recent take, leaving any existing summary in place. */
	async retranscribe(): Promise<void> {
		if (this.session.segments.length === 0) {
			new Notice('No audio to transcribe.');
			return;
		}
		if (this.isBusy()) {
			new Notice('A transcription or summary is already running.');
			return;
		}
		// A manual retry always means "redo the last take", even if it already has a
		// transcript — transcribeStep() otherwise prefers an untranscribed segment.
		this.session.segments[this.session.segments.length - 1].transcript = '';
		const ok = await this.transcribeStep();
		if (!ok) return;
		this.setStatus(this.session.summary ? 'ready' : 'recorded');
		this.setProgress('Transcript updated.', 100);
		this.session.activeTab = 'transcript';
		this.refreshViews();
		await this.syncNote();
		window.setTimeout(() => this.clearProgressIfIdle(), 4000);
	}

	/** Read a segment's audio bytes, loading them from the vault if not already in memory. */
	private async getSegmentAudioData(segment: AudioSegment): Promise<ArrayBuffer | null> {
		if (segment.audioData) return segment.audioData;
		if (!segment.audioSourcePath) return null;
		const file = this.app.vault.getAbstractFileByPath(segment.audioSourcePath);
		if (!(file instanceof TFile)) return null;
		try {
			return await this.app.vault.readBinary(file);
		} catch {
			return null;
		}
	}

	/** Transcribe whichever segment still needs it (or the newest one, for a manual retry). */
	private async transcribeStep(): Promise<boolean> {
		const s = this.session;
		if (s.segments.length === 0) {
			new Notice('No audio to transcribe.');
			return false;
		}
		const segment = s.segments.find((seg) => !seg.transcript.trim()) ?? s.segments[s.segments.length - 1];
		const audioData = await this.getSegmentAudioData(segment);
		if (!audioData) {
			new Notice('Could not read audio for this take.');
			return false;
		}
		s.error = null;
		this.setStatus('transcribing');
		this.setProgress('Transcribing audio…', 30);
		this.refreshViews();
		if (this.settings.unloadOllamaBeforeTranscribe) {
			await this.toggleLaunchAgent('unload', this.settings.ollamaServiceLabel);
		}
		const name = segment.audioName || 'recording.webm';
		const wantSpeakers = s.diarize;

		// One attempt, with its own internal diarize→flat fallback. Reused for both the
		// original try and the post-restart retry below, so both go through the same
		// speaker-identification fallback rather than duplicating that logic.
		const attempt = async (signal: AbortSignal): Promise<{ text: string; hasSpeakers: boolean; fellBack: boolean }> => {
			try {
				const r = await this.ai.transcribe(audioData, name, segment.audioMime, wantSpeakers, signal);
				return { ...r, fellBack: false };
			} catch (diarErr) {
				if (signal.aborted || !wantSpeakers) throw diarErr;
				new Notice('Speaker identification failed — transcribing without speaker labels.');
				this.setProgress('Retrying without speaker identification…', 30);
				this.refreshViews();
				const r = await this.ai.transcribe(audioData, name, segment.audioMime, false, signal);
				return { ...r, fellBack: true };
			}
		};

		const controller = new AbortController();
		this.activeController = controller;
		let result: { text: string; hasSpeakers: boolean; fellBack: boolean };
		try {
			try {
				result = await attempt(controller.signal);
			} catch (err) {
				if (controller.signal.aborted || !this.settings.restartWhisperOnTranscribeFailure) throw err;
				// whisper.cpp's Metal backend can get stuck in an error state after a real
				// out-of-memory failure, failing every request afterward regardless of size,
				// until the process itself restarts — so try exactly that, once, rather than
				// requiring a manual launchctl restart.
				new Notice('Transcription failed — restarting the Whisper server and retrying once…', 6000);
				await this.toggleLaunchAgent('unload', this.settings.unloadServiceLabel);
				await this.toggleLaunchAgent('load', this.settings.unloadServiceLabel);
				// Give the model time to actually reload before hammering it again — a large
				// local model can take a while to come back up.
				await new Promise((r) => window.setTimeout(r, 15000));
				this.setProgress('Retrying transcription…', 30);
				this.refreshViews();
				result = await attempt(controller.signal);
			}
		} catch (err) {
			if (controller.signal.aborted) {
				this.finishCancelled();
				return false;
			}
			s.error = errorMessage(err);
			this.setStatus('error');
			this.setProgress('', 0);
			this.refreshViews();
			new Notice('Transcription failed: ' + s.error);
			return false;
		} finally {
			if (this.activeController === controller) this.activeController = null;
			if (this.settings.unloadOllamaBeforeTranscribe) {
				await this.toggleLaunchAgent('load', this.settings.ollamaServiceLabel);
			}
		}
		segment.transcript = result.text;
		// Diarization was requested and the request *succeeded*, but the endpoint gave
		// back no speaker labels — it silently ignored the request. Say so, so a flat
		// transcript doesn't look like the feature is broken. (Skip if we already fell
		// back above, which explained the flat result.)
		if (wantSpeakers && !result.fellBack && !result.hasSpeakers) {
			new Notice('This endpoint returned no speaker labels — saved as a flat transcript. It may not support speaker identification.');
		}
		if (!segment.transcript.trim()) {
			s.error = 'Transcription returned no text. The clip may be silent or in an unsupported format.';
			this.setStatus('error');
			this.setProgress('', 0);
			this.refreshViews();
			return false;
		}
		// Recompute the combined transcript from every segment, in recording order.
		s.transcript = s.segments
			.map((seg) => seg.transcript)
			.filter((t) => t.trim())
			.join('\n\n---\n\n');
		return true;
	}

	async regenerateSummary(): Promise<void> {
		if (!this.session.transcript.trim()) {
			new Notice('Nothing to summarize yet.');
			return;
		}
		if (this.isBusy()) {
			new Notice('A transcription or summary is already running.');
			return;
		}
		await this.summarizeInternal();
	}

	/** Regenerate just the title (or just the tags) from the current summary/transcript. */
	async regenerateTitle(): Promise<void> {
		await this.regeneratePiece('title');
	}

	async regenerateTags(): Promise<void> {
		await this.regeneratePiece('tags');
	}

	private async regeneratePiece(piece: 'title' | 'tags'): Promise<void> {
		const s = this.session;
		const basis = s.summary || s.transcript;
		if (!basis.trim()) {
			new Notice('Summarize or transcribe first.');
			return;
		}
		if (s.status === 'summarizing' || s.status === 'transcribing') return;
		if (this.settings.unloadServiceBeforeLLM) await this.toggleLaunchAgent('unload', this.settings.unloadServiceLabel);
		const controller = new AbortController();
		this.activeController = controller;
		this.setStatus('summarizing');
		this.setProgress(piece === 'title' ? 'Naming…' : 'Tagging…', 80);
		this.refreshViews();
		try {
			if (piece === 'title') {
				s.title = await this.ai.generateTitle(basis, controller.signal, s.reasoningEffort);
				s.summary = structureSummary(s.summary, s.title.trim() || 'Summary');
				await this.renameNoteToMatchTitle();
			} else {
				s.tags = await this.ai.generateTags(s.title, basis, this.getVaultTags(), controller.signal, s.reasoningEffort);
			}
			this.setStatus('ready');
			this.setProgress(piece === 'title' ? 'Title updated.' : 'Tags updated.', 100);
			this.refreshViews();
			await this.syncNote();
			window.setTimeout(() => this.clearProgressIfIdle(), 3000);
		} catch (err) {
			if (controller.signal.aborted) {
				this.finishCancelled();
				return;
			}
			this.setStatus(s.summary ? 'ready' : 'recorded');
			this.setProgress('', 0);
			this.refreshViews();
			new Notice(`${piece === 'title' ? 'Title' : 'Tag'} generation failed: ${errorMessage(err)}`);
		} finally {
			if (this.activeController === controller) this.activeController = null;
			if (this.settings.unloadServiceBeforeLLM) await this.toggleLaunchAgent('load', this.settings.unloadServiceLabel);
		}
	}

	private async summarizeInternal(): Promise<void> {
		const s = this.session;
		s.error = null;
		s.summary = '';
		s.reasoning = '';
		this.setStatus('summarizing');
		this.setProgress('Summarizing…', 60);
		s.activeTab = 'summary';
		this.refreshViews();

		const contextDocs = await this.readContextDocs();

		if (this.settings.unloadServiceBeforeLLM) await this.toggleLaunchAgent('unload', this.settings.unloadServiceLabel);

		const controller = new AbortController();
		this.activeController = controller;
		try {
			try {
				const result = await this.ai.summarize(
					{
						transcript: s.transcript,
						memo: s.memo,
						participants: s.participants.join(', '),
						contextDocs,
					},
					{
						signal: controller.signal,
						reasoning: s.reasoningEffort,
						onDelta: s.stream
							? (answer, reasoning) => {
									s.summary = answer;
									s.reasoning = reasoning;
									this.updateStreamingViews();
							  }
							: undefined,
					}
				);
				s.summary = result.summary;
				s.reasoning = result.reasoning;
			} catch (err) {
				if (controller.signal.aborted) {
					this.finishCancelled();
					return;
				}
				s.error = errorMessage(err);
				this.setStatus('error');
				this.setProgress('', 0);
				this.refreshViews();
				new Notice('Summarization failed: ' + s.error);
				return;
			}

			// Title + tags are best-effort; failures here don't block the summary
			// (but a cancel still stops the whole run).
			this.setProgress('Naming & tagging…', 85);
			this.refreshViews();
			const basis = s.summary || s.transcript;

			if (this.settings.generateTitle && !s.title.trim()) {
				try {
					s.title = await this.ai.generateTitle(basis, controller.signal, s.reasoningEffort);
					await this.renameNoteToMatchTitle();
				} catch (err) {
					if (controller.signal.aborted) {
						this.finishCancelled();
						return;
					}
					console.warn('Scuttlebutt: title generation failed', err);
				}
			}
			if (this.settings.generateTags && s.tags.length === 0) {
				try {
					s.tags = await this.ai.generateTags(s.title, basis, this.getVaultTags(), controller.signal, s.reasoningEffort);
				} catch (err) {
					if (controller.signal.aborted) {
						this.finishCancelled();
						return;
					}
					console.warn('Scuttlebutt: tag generation failed', err);
				}
			}

			// Note shape: a single title H1, then the overview, then ## / smaller
			// sections. Uses the generated title (falls back to "Summary").
			s.summary = structureSummary(s.summary, s.title.trim() || 'Summary');

			this.setStatus('ready');
			this.setProgress('Summary ready. Saving…', 95);
			this.refreshViews();
			await this.syncNote();
			this.setProgress('Saved ✓', 100);
			this.refreshViews();
			window.setTimeout(() => this.clearProgressIfIdle(), 4000);
		} finally {
			if (this.activeController === controller) this.activeController = null;
			if (this.settings.unloadServiceBeforeLLM) await this.toggleLaunchAgent('load', this.settings.unloadServiceLabel);
		}
	}

	private clearProgressIfIdle(): void {
		if (this.session.status === 'ready' || this.session.status === 'recorded') {
			this.setProgress('', 0);
			this.refreshViews();
		}
	}

	/** Abort the in-flight transcription/summary request, if any. */
	cancelActive(): void {
		if (!this.activeController) return;
		this.activeController.abort();
		this.setProgress('Cancelling…', this.session.progressPct);
		this.refreshViews();
	}

	/** Reset the UI to a usable state after the user cancels, keeping any existing work. */
	private finishCancelled(): void {
		const s = this.session;
		s.error = null;
		// If "Add recording" already started a new take in the meantime, leave that
		// status alone instead of clobbering it with the now-stale cancelled state.
		if (!this.recorder.isActive()) {
			this.setStatus(s.summary ? 'ready' : s.segments.length > 0 ? 'recorded' : 'idle');
		}
		this.setProgress('', 0);
		this.refreshViews();
		new Notice('Cancelled.');
	}

	private async readContextDocs(): Promise<{ path: string; content: string }[]> {
		const docs: { path: string; content: string }[] = [];
		for (const path of this.session.contextFiles) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				try {
					docs.push({ path, content: await this.app.vault.cachedRead(file) });
				} catch {
					new Notice(`Could not read context file: ${path}`);
				}
			} else {
				new Notice(`Context file missing, skipped: ${path}`);
			}
		}
		return docs;
	}

	private getVaultTags(): string[] {
		try {
			// getTags() is an undocumented (but stable) MetadataCache method not in the typings.
			const cache = this.app.metadataCache as unknown as { getTags?: () => Record<string, number> };
			const tags = cache.getTags?.();
			if (!tags) return [];
			return Object.keys(tags)
				.map((t) => t.replace(/^#/, ''))
				.slice(0, 100);
		} catch {
			return [];
		}
	}

	// ---- saving ----------------------------------------------------------

	/**
	 * Reveal an already-open tab for this note instead of opening yet another one — syncNote()
	 * runs several times over one meeting (after recording, after transcript, after summary),
	 * so a naive "always open a new leaf" would otherwise duplicate the tab every single time.
	 */
	private async revealOrOpenNote(path: string): Promise<void> {
		const existing = this.app.workspace
			.getLeavesOfType('markdown')
			.find((leaf) => (leaf.view as { file?: TFile }).file?.path === path);
		if (existing) {
			this.app.workspace.setActiveLeaf(existing, { focus: true });
			return;
		}
		await this.app.workspace.openLinkText(path, '', true);
	}

	async saveNote(): Promise<void> {
		const s = this.session;
		if (s.segments.length === 0 && !s.summary && !s.transcript) {
			new Notice('Nothing to save yet.');
			return;
		}
		if (this.isBusy()) {
			new Notice('Wait for the current step to finish before saving.');
			return;
		}
		await this.syncNote();
		if (s.savedNotePath && !s.error) new Notice('Meeting note saved: ' + s.savedNotePath);
	}

	/**
	 * Auto-save: writes/updates the note without user-facing "nothing to save" chatter.
	 * Called after every recording and after transcription/summary complete, so there is
	 * never a manual "Save" step required. Safe to call mid-pipeline (e.g. right after a
	 * take is recorded, before it's even transcribed) — status/progress are only touched
	 * when nothing else is already in progress.
	 */
	async syncNote(): Promise<void> {
		const s = this.session;
		if (s.segments.length === 0 && !s.summary && !s.transcript) return;
		const wasBusy = this.isBusy();
		if (!wasBusy) {
			this.setStatus('saving');
			this.setProgress('Saving note…', 90);
			this.refreshViews();
		}
		try {
			if (this.settings.saveAudio) {
				for (const seg of s.segments) {
					if (seg.audioData && !seg.audioSourcePath) {
						seg.audioSourcePath = await this.saveSegmentAudio(seg);
					}
				}
			}
			const notePath =
				s.foreignNote && s.savedNotePath ? await this.mergeIntoForeignNote(s.savedNotePath) : await this.writeNote();
			s.savedNotePath = notePath;
			if (!wasBusy) {
				this.setStatus(s.summary ? 'ready' : 'recorded');
				this.setProgress('Saved ✓', 100);
				this.refreshViews();
				if (this.settings.autoOpenNote) void this.revealOrOpenNote(notePath);
				window.setTimeout(() => this.clearProgressIfIdle(), 4000);
			}
		} catch (err) {
			s.error = 'Could not save note: ' + errorMessage(err);
			if (!wasBusy) {
				this.setStatus('error');
				this.setProgress('', 0);
				this.refreshViews();
			}
			new Notice(s.error);
		}
	}

	private async saveSegmentAudio(segment: AudioSegment): Promise<string> {
		await this.ensureFolder(this.settings.audioFolder);
		const ext = (segment.audioName.split('.').pop() || 'webm').toLowerCase();
		// segment.id is "<epoch-ms-when-recorded/imported>-<random>" (see stopRecording,
		// importFromVault/Disk, scuttlebuttifyActiveNote) — use that moment, not whenever
		// the save happens to run, so the filename reflects when it was actually recorded.
		const recordedAt = Number(segment.id.split('-')[0]);
		const stampDate = Number.isFinite(recordedAt) ? new Date(recordedAt) : new Date();
		const base = sanitizeFileName(`Recording ${recordingStamp(stampDate)}`);
		const path = await this.uniquePath(this.settings.audioFolder, base, ext);
		await this.app.vault.createBinary(path, segment.audioData!);
		return path;
	}

	/**
	 * Rename the saved note to match the current title, once one is known — needed now
	 * that the note file exists (with a generic "Meeting" name) before any title does.
	 * writeNote() itself never renames an existing file, only updates its content, so
	 * without this the file would stay named "Meeting" forever. Never touches a note we
	 * don't own (foreignNote) or one that isn't saved yet.
	 */
	private async renameNoteToMatchTitle(): Promise<void> {
		const s = this.session;
		if (!s.savedNotePath || s.foreignNote) return;
		const file = this.app.vault.getAbstractFileByPath(s.savedNotePath);
		if (!(file instanceof TFile)) return;
		const title = s.title.trim() || 'Meeting';
		const idealBase = sanitizeFileName(
			applyTemplate(this.settings.filenameTemplate || DEFAULT_FILENAME_TEMPLATE, {
				date: todayStamp(new Date()),
				title,
			})
		);
		if (file.basename === idealBase) return;
		const newPath = await this.uniquePath(this.settings.notesFolder, idealBase, 'md');
		try {
			await this.app.fileManager.renameFile(file, newPath);
			s.savedNotePath = newPath;
		} catch (err) {
			console.warn('Scuttlebutt: could not rename note to match title', err);
		}
	}

	private async writeNote(): Promise<string> {
		const s = this.session;
		await this.ensureFolder(this.settings.notesFolder);

		const now = new Date();
		const title = s.title.trim() || 'Meeting';
		const base = sanitizeFileName(
			applyTemplate(this.settings.filenameTemplate || DEFAULT_FILENAME_TEMPLATE, {
				date: todayStamp(now),
				title,
			})
		);
		const existing = s.savedNotePath ? this.app.vault.getAbstractFileByPath(s.savedNotePath) : null;
		const path =
			existing instanceof TFile ? existing.path : await this.uniquePath(this.settings.notesFolder, base, 'md');

		const fm: string[] = ['---'];
		fm.push('scuttlebutt: true');
		fm.push(`date created: ${yamlString(mmt(now).format(this.settings.dateFormat || DEFAULT_DATE_FORMAT))}`);
		if (s.tags.length > 0) fm.push(`tags: [${s.tags.map(yamlString).join(', ')}]`);
		if (s.participants.length > 0) {
			fm.push(`participants: [${s.participants.map(yamlString).join(', ')}]`);
		}
		fm.push('---', '');

		const parts: string[] = [fm.join('\n')];

		for (const seg of s.segments) {
			if (seg.audioSourcePath) parts.push(`![[${seg.audioSourcePath}]]`, '');
		}

		parts.push(s.summary.trim() || '*No summary generated.*');

		if (this.settings.includeMemo && s.memo.trim()) {
			parts.push('', calloutBlock('quote', 'Memo', s.memo.trim(), true));
		}
		if (this.settings.includeTranscript && s.transcript.trim()) {
			parts.push('', calloutBlock('note', 'Transcript', s.transcript.trim(), true));
		}

		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, parts.join('\n') + '\n');
			return existing.path;
		}
		const file = await this.app.vault.create(path, parts.join('\n') + '\n');
		return file.path;
	}

	/**
	 * Merge into a note we don't own: only ever touch a marked block, plus embeds for any
	 * segment audio not already referenced somewhere in the file. Everything else the user
	 * wrote — title, existing embeds, handwritten notes — is left exactly as it was.
	 */
	private async mergeIntoForeignNote(notePath: string): Promise<string> {
		const s = this.session;
		const file = this.app.vault.getAbstractFileByPath(notePath);
		if (!(file instanceof TFile)) throw new Error('Note no longer exists: ' + notePath);

		// Merge the scuttlebutt flag + tags into whatever frontmatter is already there —
		// Obsidian's own API handles this without disturbing other keys.
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			fm.scuttlebutt = true;
			if (s.tags.length > 0) {
				const current = fm.tags;
				const existing: string[] = Array.isArray(current)
					? current.map(String)
					: typeof current === 'string' && current
						? [current]
						: [];
				fm.tags = Array.from(new Set([...existing, ...s.tags]));
			}
		});

		const content = await this.app.vault.read(file);

		// Only embed segments whose audio isn't already referenced somewhere in the file —
		// audio the user already placed there stays exactly where they put it.
		const alreadyEmbedded = new Set(
			extractAudioEmbeds(content)
				.map((link) => this.app.metadataCache.getFirstLinkpathDest(link, file.path)?.path)
				.filter((p): p is string => !!p)
		);
		const newAudioLinks = s.segments
			.map((seg) => seg.audioSourcePath)
			.filter((p): p is string => !!p && !alreadyEmbedded.has(p));

		const blockParts: string[] = [];
		for (const link of newAudioLinks) blockParts.push(`![[${link}]]`);
		if (newAudioLinks.length > 0) blockParts.push('');
		blockParts.push(s.summary.trim() || '*No summary generated.*');
		if (this.settings.includeMemo && s.memo.trim()) {
			blockParts.push('', calloutBlock('quote', 'Memo', s.memo.trim(), true));
		}
		if (this.settings.includeTranscript && s.transcript.trim()) {
			blockParts.push('', calloutBlock('note', 'Transcript', s.transcript.trim(), true));
		}
		const block = `<!--scuttlebutt:start-->\n${blockParts.join('\n')}\n<!--scuttlebutt:end-->`;

		const markerRe = /<!--scuttlebutt:start-->[\s\S]*?<!--scuttlebutt:end-->/;
		const newContent = markerRe.test(content)
			? content.replace(markerRe, block)
			: content.replace(/\n*$/, '') + '\n\n' + block + '\n';

		await this.app.vault.modify(file, newContent);
		return file.path;
	}

	// ---- reset -----------------------------------------------------------

	/** Drop a take from the session (the underlying vault file, if any, is left alone —
	 * only our tracking of it is removed) and resync the note to match. */
	removeSegment(id: string): void {
		const s = this.session;
		const idx = s.segments.findIndex((seg) => seg.id === id);
		if (idx === -1) return;
		s.segments.splice(idx, 1);
		s.transcript = s.segments
			.map((seg) => seg.transcript)
			.filter((t) => t.trim())
			.join('\n\n---\n\n');
		if (s.segments.length === 0 && !s.summary) this.setStatus('idle');
		this.refreshViews();
		void this.syncNote();
	}

	resetSession(): void {
		if (this.recorder.isRecording()) this.recorder.abort();
		this.stopStatusBarTimer();
		this.session = newSession(this.settings.sttDiarize, this.settings.reasoningEffort, this.settings.streamSummary);
		this.refreshViews();
	}

	// ---- filesystem helpers ---------------------------------------------

	private async ensureFolder(folder: string): Promise<void> {
		const norm = normalizePath(folder);
		if (!norm || norm === '/' || norm === '.') return;
		const segments = norm.split('/');
		let current = '';
		for (const seg of segments) {
			current = current ? `${current}/${seg}` : seg;
			if (!this.app.vault.getAbstractFileByPath(current)) {
				try {
					await this.app.vault.createFolder(current);
				} catch (err) {
					// Ignore "already exists" races; rethrow anything else.
					if (!this.app.vault.getAbstractFileByPath(current)) throw err;
				}
			}
		}
	}

	private async uniquePath(folder: string, base: string, ext: string): Promise<string> {
		const dir = normalizePath(folder);
		let candidate = normalizePath(`${dir}/${base}.${ext}`);
		let i = 2;
		while (this.app.vault.getAbstractFileByPath(candidate)) {
			candidate = normalizePath(`${dir}/${base} (${i}).${ext}`);
			i++;
		}
		return candidate;
	}

	// ---- status bar ------------------------------------------------------

	private startStatusBarTimer(): void {
		this.updateStatusBar();
		if (this.statusBarTimer !== null) return;
		this.statusBarTimer = window.setInterval(() => this.updateStatusBar(), 1000);
		this.registerInterval(this.statusBarTimer);
	}

	private stopStatusBarTimer(): void {
		if (this.statusBarTimer !== null) {
			window.clearInterval(this.statusBarTimer);
			this.statusBarTimer = null;
		}
		if (this.statusBarEl) this.statusBarEl.addClass('mh-hidden');
	}

	private updateStatusBar(): void {
		if (!this.statusBarEl) return;
		if (this.session.status === 'recording') {
			this.statusBarEl.removeClass('mh-hidden');
			this.statusBarEl.empty();
			this.statusBarEl.createSpan({ cls: 'mh-sb-dot' });
			const t = formatDuration(recordedMs(this.session.activeMs, this.session.segmentStartedAt, Date.now()));
			this.statusBarEl.createSpan({ text: ' ' + t + (this.session.paused ? ' (paused)' : '') });
			this.statusBarEl.onclick = () => this.activateView();
		} else {
			this.statusBarEl.addClass('mh-hidden');
		}
	}
}

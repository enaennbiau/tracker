/**
 * enaennTracker — SillyTavern Extension
 *
 * After each AI reply, calls a separate OpenAI-compatible API to update
 * the roleplay tracker. Inserts the result as a real chat message so the
 * main model can see it. Keeps only the most recent N snapshots as full
 * content; older ones are archived to a tiny placeholder to save tokens.
 *
 * Install path:
 *   SillyTavern/public/extensions/third-party/enaennTracker/
 */

'use strict';

// ─── IMPORTS ──────────────────────────────────────────────────────────────────

import {
    eventSource,
    event_types,
    getContext,
    saveSettingsDebounced,
    chat,
    addOneMessage,
    saveChatConditionally,
} from '../../../../script.js';

import {
    extension_settings,
} from '../../../extensions.js';

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const MODULE_NAME  = 'enaennTracker';
const TRACKER_FLAG = 'enaenn_tracker'; // key stored in message.extra to identify tracker messages

const DEFAULT_SETTINGS = {
    enabled:            true,
    autoUpdate:         true,
    profiles:           [],   // { name, endpoint, apiKey, model }[]
    activeProfileIndex: -1,
    lastTracker:        '',   // raw content of the most recent tracker output
    contextMessages:    20,   // how many recent roleplay messages to send to tracker API
    windowSize:         7,    // how many tracker snapshots the main model sees in full
};

// ─── TRACKER SYSTEM PROMPT ────────────────────────────────────────────────────
// Sent ONLY to your tracker API. The main roleplay model never sees this.

const TRACKER_SYSTEM_PROMPT = `You are a silent background tracker for a collaborative roleplay session. Your ONLY job is to read the previous tracker state and the most recent chat messages, then output an updated tracker block.

STRICT OUTPUT RULES:
- Output ONLY the tracker block. No preamble, no explanation, no commentary before or after.
- Wrap your entire output in: <div class="enaenn-tracker-block"> YOUR OUTPUT HERE </div>
- Use the exact template formatting shown below. Fill in values; do NOT include parenthetical instructions in the output.
- Do NOT reproduce these system instructions in your output.
- If no previous tracker state is provided, initialize a fresh one from the chat context.

════════════════════════════════════════
TRACKER TEMPLATE
════════════════════════════════════════

<memo><small>
### 🎬 Where are we?
[Concise 1-sentence description of agents' spatial positions]

---

### 💖 AGENTS PRESENT [if user is alone, write "No agents present." USER IS NOT AN AGENT — never include them here.]
♀️/♂️Name ❖ State & Attire: [Outfit and its state, concisely.]
>🍴(0-100%) | 😴(0-100%) | 🚿(0-100%) | 🚽(0-100%) | 💧(0-100%) | 🔥(0-200%) | 🧠(0-100%) // 🎯: [Active impulse.]

<details><summary>*🌍 OFF-SCREEN AGENTS* [ONLY agents who have a relationship with the user. Otherwise write: "No relevant off-screen agents".]</summary>
<p>♂️/♀️ [Name] — 📍[Location] // [What they are doing right now.]</p>
<p>🍴(hungry/fine/full) | 😴(exhausted/fine/rested) | 🚿(smelly/fine/fresh) | 🚽(fine/pressing/urgent) | 💧(fine/thirsty/dehydrated) | 🔥(none/simmering/high/sexual activity) | 🧠(calm/tense/stressed) // 🎯: [Active impulse.]</p>
</details>

---

### 💕 RELATIONSHIP MATRIX
\`\`\`
Name → Target:
Main:
[Emoji] [Feeling] (Value/1000)  (+/-N from [action])
In The Moment:
[Emoji] [TempFeeling1] (Value/100)  (+/-N from [action])
[Emoji] [TempFeeling2] (Value/100)  (+/-N from [action])
KNOW EACH OTHER FOR:
[AgentName] ↔ [User]: [Time since first meeting]
STAGE: [e.g. "Strangers", "Growing Friendship"]
\`\`\`

---

### 📅 FUTURE PLANS

• **[day, month]** — [Concise note of upcoming agreed events, chronological.]
</small></memo>

════════════════════════════════════════
VITAL TRACKING GUIDELINES
════════════════════════════════════════

VITAL POLARITIES — do NOT confuse these:
  LOW = critical: 🍴 food satiation | 😴 energy | 🚿 cleanliness
  HIGH = critical: 💧 thirst | 🔥 arousal | 🚽 bladder | 🧠 stress

VITAL RATES (per 5 min / per hour):
  🍴  decay -0.2–0.4% / -2.4–4.8%.  Meal: +60–80%. Snack: +10–17%.
  😴  decay -0.25–0.33% / -3–4% (normal); -0.4–0.6% / -5–7% (strenuous).
      Sleep restores +10–15%/hr. At 100% → wake (unless <6 hr slept at night, then continue for circadian realism). Never use sleep as scene-closer.
  🚿  decay -0.05–0.15% / -0.6–1.8% (×3–4 during exertion/heat/dirt).
      Shower: +95–100%. Quick wash: +5–10%. Clean clothes: +3–5%.
  💧/🚽 rise +0.3–0.7% / +4–8%. Glass of water: 💧 −45–55%, 🚽 +8–12%. Bottle: 💧 −100%, 🚽 +20–25%.
  🧠  decay -0.3–0.5% / -3.6–6% during restful/positive/sleep. Rises from unmet needs, friction, danger. If 🧠 > 75% → agent seeks stress relief.
  🔥  build +2–8%/5min. Decay (no stimulus) ~-0.5%/5min. Values >100% = sexual activity only. 200% = climax.

NEED PRIORITY when critical: 🚽 > 💧 > 🍴 > 😴 > 🚿.
DISPLAY every change, e.g. "😴: 55.8% (−0.2%)" for every agent.
🩹 CONDITION: Track injuries, intoxication, illness, pain, medication, temperature discomfort. Affects vitals and behavior.

RELATIONSHIP MATRIX RULES:
  Main feeling (0–1000): develops slowly. Max +10 pts/in-game day unless major event. Naturally evolves at 0 or 1000.
  In The Moment (0–100, max 4 feelings): tied to current events.
    At 100 or 0 → transform into natural successor/predecessor.
    Negative transformation → deduct 1–20 from Main. Positive → add 1–5 to Main.
  Off-screen agents: keep only Main feeling + status + 'known for'.
  Avoidant agents: 🧠 +10–15/day after 48 hr sustained proximity.
  Choose feeling words as the AGENT would define them.`;

// ─── SETTINGS HELPERS ─────────────────────────────────────────────────────────

function initSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
        return;
    }
    // Fill in any keys added in future versions
    for (const [key, val] of Object.entries(DEFAULT_SETTINGS)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = val;
        }
    }
}

/** Quick reference to settings object */
const S = () => extension_settings[MODULE_NAME];

/** Merge-patch and debounce-save */
function save(patch = {}) {
    Object.assign(extension_settings[MODULE_NAME], patch);
    saveSettingsDebounced();
}

function getActiveProfile() {
    const idx = S().activeProfileIndex;
    if (idx < 0 || idx >= S().profiles.length) return null;
    return S().profiles[idx];
}

// ─── CHAT / WINDOW HELPERS ────────────────────────────────────────────────────

/** Returns the chat indices of all tracker messages, oldest first */
function getTrackerIndices() {
    return chat
        .map((m, i) => ({ m, i }))
        .filter(({ m }) => m.extra?.[TRACKER_FLAG] === true)
        .map(({ i }) => i);
}

/** Collapse a tracker message to the archived placeholder */
function archiveTrackerAt(idx) {
    const m = chat[idx];
    if (!m || m.extra?.archived) return;

    // Preserve full content before overwriting
    if (!m.extra.fullContent) {
        m.extra.fullContent = m.mes;
    }
    m.extra.archived = true;
    m.mes = '<div class="enaenn-tracker-archived">📋 <em>[archived tracker]</em></div>';

    // Update the DOM element if it is currently rendered
    $(`#chat .mes[mesid="${idx}"]`).find('.mes_text').html(m.mes);
}

/** Restore an archived tracker message to its full content */
function restoreTrackerAt(idx) {
    const m = chat[idx];
    if (!m || !m.extra?.archived) return;

    m.mes = m.extra.fullContent || m.mes;
    m.extra.archived = false;

    $(`#chat .mes[mesid="${idx}"]`).find('.mes_text').html(m.mes);
}

/**
 * Enforce the sliding window.
 * The newest `windowSize` tracker messages stay at full content.
 * Everything older is archived to a tiny placeholder.
 */
async function enforceWindow() {
    const windowSize = S().windowSize;
    const indices    = getTrackerIndices();
    if (indices.length === 0) return;

    const cutoff   = Math.max(0, indices.length - windowSize);
    const toArchive = indices.slice(0, cutoff);
    const toRestore = indices.slice(cutoff);

    let changed = false;

    for (const idx of toArchive) {
        if (!chat[idx]?.extra?.archived) {
            archiveTrackerAt(idx);
            changed = true;
        }
    }
    for (const idx of toRestore) {
        if (chat[idx]?.extra?.archived) {
            restoreTrackerAt(idx);
            changed = true;
        }
    }

    if (changed) {
        await saveChatConditionally();
    }
}

// ─── TRACKER API CALL ─────────────────────────────────────────────────────────

async function callTrackerAPI() {
    const profile = getActiveProfile();

    if (!profile) {
        toastr.warning('enaennTracker: No API profile selected. Open Extensions → enaennTracker.');
        return null;
    }
    if (!profile.endpoint || !profile.model) {
        toastr.warning('enaennTracker: Active profile is missing Endpoint URL or Model name.');
        return null;
    }

    // Collect recent ROLEPLAY messages only — tracker messages are excluded
    // so the tracker API gets clean story context, not its own previous outputs.
    const recentRoleplay = chat
        .filter(m => !m.extra?.[TRACKER_FLAG])
        .slice(-(S().contextMessages));

    const chatText = recentRoleplay
        .map(m => `${m.name || (m.is_user ? 'User' : 'Character')}: ${m.mes || ''}`)
        .join('\n\n');

    const prevState = S().lastTracker
        ? `PREVIOUS TRACKER STATE:\n${S().lastTracker}`
        : 'No previous tracker state. Initialize a fresh one from the chat context.';

    const userMessage =
        `${prevState}\n\n---\n\n` +
        `RECENT ROLEPLAY (${recentRoleplay.length} messages):\n${chatText}\n\n---\n\n` +
        `Output the updated tracker wrapped in <div class="enaenn-tracker-block">...</div>. Nothing else.`;

    try {
        const base     = profile.endpoint.replace(/\/+$/, '');
        const response = await fetch(`${base}/chat/completions`, {
            method:  'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(profile.apiKey ? { Authorization: `Bearer ${profile.apiKey}` } : {}),
            },
            body: JSON.stringify({
                model:       profile.model,
                messages: [
                    { role: 'system', content: TRACKER_SYSTEM_PROMPT },
                    { role: 'user',   content: userMessage },
                ],
                max_tokens:  1500,
                temperature: 0.2,
                stream:      false,
            }),
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errText.slice(0, 300)}`);
        }

        const data = await response.json();
        return data.choices?.[0]?.message?.content?.trim() ?? null;

    } catch (err) {
        console.error('[enaennTracker]', err);
        toastr.error(`enaennTracker: ${err.message}`);
        return null;
    }
}

// ─── INSERT TRACKER MESSAGE ───────────────────────────────────────────────────

async function insertTrackerMessage(content) {
    // Guarantee our wrapper div is present
    const wrapped = content.includes('enaenn-tracker-block')
        ? content
        : `<div class="enaenn-tracker-block">${content}</div>`;

    const mesObj = {
        name:      'Tracker',
        is_user:   false,
        is_system: false,
        mes:       wrapped,
        send_date: new Date().toLocaleString(),
        extra: {
            [TRACKER_FLAG]: true,   // marks this as a tracker message
            fullContent:   wrapped, // always kept so we can restore from archive
            archived:      false,
            token_count:   0,
        },
    };

    chat.push(mesObj);

    // Ask ST to render the message into the DOM
    try {
        await addOneMessage(mesObj, { scroll: true, type: 'narrator' });
    } catch (e) {
        // Fallback: manual DOM injection if addOneMessage is unavailable
        console.warn('[enaennTracker] addOneMessage unavailable, using fallback:', e);
        const mesId = chat.length - 1;
        $('#chat').append(`
            <div class="mes" mesid="${mesId}">
                <div class="mes_block">
                    <div class="name_text">Tracker</div>
                    <div class="mes_text">${wrapped}</div>
                </div>
            </div>`);
    }

    await saveChatConditionally();
}

// ─── MAIN UPDATE FLOW ─────────────────────────────────────────────────────────

let _updating = false;

async function updateTracker() {
    if (_updating) return;
    if (!S().enabled) return;

    _updating = true;
    setLoadingState(true);

    const result = await callTrackerAPI();

    setLoadingState(false);
    _updating = false;

    if (!result) return;

    const wrapped = result.includes('enaenn-tracker-block')
        ? result
        : `<div class="enaenn-tracker-block">${result}</div>`;

    // Persist latest tracker content (used as "previous state" on next call)
    save({ lastTracker: wrapped });

    // Insert as a new chat message
    await insertTrackerMessage(wrapped);

    // Archive old tracker snapshots beyond the window
    await enforceWindow();

    toastr.success('Tracker updated!', '', { timeOut: 1500 });
}

// ─── UI ───────────────────────────────────────────────────────────────────────

function setLoadingState(loading) {
    $('#enaennTracker_refreshBtn')
        .prop('disabled', loading)
        .text(loading ? '⏳ Updating…' : '🔄 Refresh Tracker');
    $('#enaennTracker_toolbarBtn')
        .prop('disabled', loading)
        .text(loading ? '⏳' : '🔄');
}

function refreshProfileSelect() {
    const $sel = $('#enaennTracker_profileSelect')
        .empty()
        .append('<option value="-1">— Select a profile —</option>');

    S().profiles.forEach((p, i) => {
        $sel.append(
            `<option value="${i}"${i === S().activeProfileIndex ? ' selected' : ''}>${p.name || 'Unnamed'}</option>`
        );
    });
}

function refreshProfileEditor() {
    const idx = S().activeProfileIndex;
    if (idx < 0 || idx >= S().profiles.length) {
        $('#enaennTracker_profileEditor').slideUp(150);
        return;
    }
    const p = S().profiles[idx];
    $('#enaennTracker_pName').val(p.name     || '');
    $('#enaennTracker_pEndpoint').val(p.endpoint || '');
    $('#enaennTracker_pKey').val(p.apiKey    || '');
    $('#enaennTracker_pModel').val(p.model    || '');
    $('#enaennTracker_profileEditor').slideDown(150);
}

// ─── SETTINGS HTML ────────────────────────────────────────────────────────────

const SETTINGS_HTML = `
<div id="enaennTracker_root" class="extension_settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>🔄 enaennTracker</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">

      <!-- Enabled / Auto-update toggles -->
      <div class="flex-container flexGap5 enaenn-gap">
        <label class="checkbox_label">
          <input type="checkbox" id="enaennTracker_enabled" />
          <span>Enabled</span>
        </label>
        <label class="checkbox_label" style="margin-left:14px;">
          <input type="checkbox" id="enaennTracker_autoUpdate" />
          <span>Auto-update after each reply</span>
        </label>
      </div>

      <!-- Context size -->
      <div class="flex-container flexGap5 alignItemsCenter enaenn-gap">
        <label style="white-space:nowrap; min-width:175px;">
          Roleplay messages → tracker API:
        </label>
        <input type="number" id="enaennTracker_ctxSize"
               min="5" max="100" class="text_pole" style="width:60px;" />
      </div>

      <!-- Window size -->
      <div class="flex-container flexGap5 alignItemsCenter enaenn-gap">
        <label style="white-space:nowrap; min-width:175px;">
          Tracker snapshots visible to model:
        </label>
        <input type="number" id="enaennTracker_windowSize"
               min="1" max="50" class="text_pole" style="width:60px;" />
        <span style="font-size:0.78em; opacity:0.5;">(older ones archived)</span>
      </div>

      <hr />

      <!-- API Profiles -->
      <div class="enaenn-gap" style="font-weight:bold;">API Profiles</div>
      <div class="flex-container flexGap5 enaenn-gap">
        <select id="enaennTracker_profileSelect" class="text_pole flex1"></select>
        <button id="enaennTracker_addProfile"    class="menu_button" title="New profile">➕</button>
        <button id="enaennTracker_deleteProfile" class="menu_button" title="Delete selected">🗑️</button>
      </div>

      <div id="enaennTracker_profileEditor">
        <div class="editor-title">Edit Profile</div>
        <label>Name</label>
        <input type="text"     id="enaennTracker_pName"     class="text_pole" placeholder="e.g. Longcat" />
        <label>Endpoint URL</label>
        <input type="text"     id="enaennTracker_pEndpoint" class="text_pole" placeholder="https://api.openai.com/v1" />
        <label>API Key <small>(leave blank if not needed)</small></label>
        <input type="password" id="enaennTracker_pKey"      class="text_pole" placeholder="sk-..." />
        <label>Model name</label>
        <input type="text"     id="enaennTracker_pModel"    class="text_pole" placeholder="gpt-4o-mini" />
        <button id="enaennTracker_saveProfile" class="menu_button" style="margin-top:8px;">
          💾 Save Profile
        </button>
      </div>

      <hr />

      <!-- Actions -->
      <div class="flex-container flexGap5">
        <button id="enaennTracker_refreshBtn" class="menu_button flex1">
          🔄 Refresh Tracker
        </button>
        <button id="enaennTracker_clearBtn" class="menu_button"
                title="Clears the saved tracker state. Next refresh will start fresh.">
          🗑️ Clear State
        </button>
      </div>

    </div>
  </div>
</div>`;

// ─── EVENT BINDINGS ───────────────────────────────────────────────────────────

function bindUI() {
    $('#enaennTracker_enabled').on('change', function () {
        save({ enabled: this.checked });
    });

    $('#enaennTracker_autoUpdate').on('change', function () {
        save({ autoUpdate: this.checked });
    });

    $('#enaennTracker_ctxSize').on('change', function () {
        save({ contextMessages: Math.max(5, parseInt(this.value) || 20) });
    });

    $('#enaennTracker_windowSize').on('change', function () {
        const v = Math.max(1, parseInt(this.value) || 7);
        save({ windowSize: v });
        // Re-apply the window immediately when the setting changes
        enforceWindow();
    });

    $('#enaennTracker_profileSelect').on('change', function () {
        save({ activeProfileIndex: parseInt(this.value) });
        refreshProfileEditor();
    });

    $('#enaennTracker_addProfile').on('click', () => {
        const profiles = [...S().profiles, { name: 'New Profile', endpoint: '', apiKey: '', model: '' }];
        save({ profiles, activeProfileIndex: profiles.length - 1 });
        refreshProfileSelect();
        refreshProfileEditor();
    });

    $('#enaennTracker_deleteProfile').on('click', () => {
        const idx = S().activeProfileIndex;
        if (idx < 0) return;
        const profiles = S().profiles.filter((_, i) => i !== idx);
        const newIdx   = profiles.length === 0 ? -1 : Math.min(idx, profiles.length - 1);
        save({ profiles, activeProfileIndex: newIdx });
        refreshProfileSelect();
        refreshProfileEditor();
    });

    $('#enaennTracker_saveProfile').on('click', () => {
        const idx = S().activeProfileIndex;
        if (idx < 0) return;
        const profiles = [...S().profiles];
        profiles[idx] = {
            name:     $('#enaennTracker_pName').val().trim()     || 'Unnamed',
            endpoint: $('#enaennTracker_pEndpoint').val().trim(),
            apiKey:   $('#enaennTracker_pKey').val().trim(),
            model:    $('#enaennTracker_pModel').val().trim(),
        };
        save({ profiles });
        refreshProfileSelect();
        toastr.success('Profile saved!');
    });

    $('#enaennTracker_refreshBtn').on('click', () => updateTracker());

    $('#enaennTracker_clearBtn').on('click', () => {
        save({ lastTracker: '' });
        toastr.info('Tracker state cleared. Next refresh will start fresh.');
    });
}

function addToolbarButton() {
    if ($('#enaennTracker_toolbarBtn').length) return; // prevent duplicates on hot-reload
    const $btn = $(`
        <div id="enaennTracker_toolbarBtn"
             title="Refresh enaennTracker"
             class="interactable">🔄</div>
    `);
    $btn.on('click', () => updateTracker());
    $('#send_but_sheld').prepend($btn);
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

jQuery(async () => {
    initSettings();

    // Inject settings panel into ST's extensions drawer
    $('#extensions_settings2').append(SETTINGS_HTML);

    // Restore saved values into the UI
    $('#enaennTracker_enabled').prop('checked',  S().enabled);
    $('#enaennTracker_autoUpdate').prop('checked', S().autoUpdate);
    $('#enaennTracker_ctxSize').val(S().contextMessages);
    $('#enaennTracker_windowSize').val(S().windowSize);
    refreshProfileSelect();
    refreshProfileEditor();

    bindUI();
    addToolbarButton();

    // ── ST event hooks ────────────────────────────────────────────────────────

    // Auto-update after the AI finishes generating a reply
    eventSource.on(event_types.MESSAGE_RECEIVED, async () => {
        if (S().enabled && S().autoUpdate) {
            // Small delay so ST finishes appending the message before we read it
            await new Promise(r => setTimeout(r, 700));
            await updateTracker();
        }
    });

    // When the chat changes (new chat, different character, page reload into a different chat):
    // - Clear the saved tracker state so the new chat starts fresh
    // - Re-enforce the window on whatever tracker messages are in the newly loaded chat
    eventSource.on(event_types.CHAT_CHANGED, async () => {
        save({ lastTracker: '' });
        await enforceWindow();
    });

    console.log('[enaennTracker] Loaded successfully.');
});

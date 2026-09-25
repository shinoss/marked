import { MODEL_ID, MODEL_ORIGINS, modelConfig } from './ai-config.js';
import { buildChatContext, visibleAnswer } from './ai-context.js';
import { safeURL } from './bookmarks.js';
import { waitForWorker } from './ai-loader.js';
import { validateAdapter } from './ai-capabilities.js';

const $ = id => document.getElementById(id);
let initialized = false, getRoot, worker, engine, releaseLock;
let loading = false, generating = false, removing = false, cached = false, epoch = 0;
let history = [];
let loadTimer;
let loadStage = '', lastLoadUpdate = 0;
function loadingStatus(message) {
  loadStage = message; lastLoadUpdate = Date.now(); status(message);
}
const config = modelConfig(browser.runtime.getURL(''));
// getBrowserInfo is Firefox-only; used to tailor compatibility messages.
const BROWSER = browser.runtime.getBrowserInfo ? 'Firefox' : 'this browser';
function status(message) { $('chat-status').textContent = message; }
function startLabel() { $('chat-start').textContent = cached ? 'Load cached model' : 'Download / load model'; }
function controls() {
  $('chat-start').disabled = loading || !!engine;
  $('chat-question').disabled = !engine || generating;
  $('chat-stop').hidden = !generating;
  $('chat-unload').disabled = removing || (!loading && !engine);
  $('chat-clear').disabled = generating;
  $('chat-delete-model').disabled = loading || generating;
}
async function claimGPU() {
  await new Promise((resolve, reject) => {
    navigator.locks.request('marked-ai-gpu', { ifAvailable: true }, async lock => {
      if (!lock) { reject(new Error('Local AI is already running in another Marked tab. Unload it there first.')); return; }
      await new Promise(release => { releaseLock = release; resolve(); });
    }).catch(reject);
  });
}
function unload() {
  clearInterval(loadTimer);
  epoch++;
  worker?.terminate(); worker = null; engine = null;
  releaseLock?.(); releaseLock = null;
  loading = false; generating = false;
  $('chat-progress').hidden = true;
  controls(); status('Model unloaded. Downloaded files remain cached locally.');
}
async function checkGPU() {
  if (!navigator.gpu) throw new Error(`WebGPU is unavailable in ${BROWSER}. Try an up-to-date Chrome, or Firefox with WebGPU enabled. There is no CPU or cloud fallback.`);
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  return validateAdapter(adapter, BROWSER);
}
// Downloaded weights persist in IndexedDB; only the GPU copy is lost on reload.
async function hasCachedModel() {
  try {
    const { hasModelInCache } = await import('./vendor/ai-runtime.js');
    return await hasModelInCache(MODEL_ID, config);
  } catch { return false; }
}
// automatic: load an already-downloaded model when the panel opens. It never
// prompts, so callers only use it when download access was granted earlier.
async function start({ automatic = false } = {}) {
  if (loading || engine) return;
  const version = ++epoch;
  loading = true; controls();
  $('chat-progress').hidden = false;
  $('chat-progress').removeAttribute('value');
  loadingStatus(automatic ? 'Loading the downloaded model from this device…' : 'Waiting for download permission… Check for a browser permission prompt.');
  loadTimer = setInterval(() => {
    if (version !== epoch || !loading) return;
    const seconds = Math.floor((Date.now() - lastLoadUpdate) / 1000);
    if (seconds >= 5) status(`${loadStage} (${seconds}s since last update)${seconds >= 60 ? ' No new progress reported. You can cancel with Unload and retry.' : ''}`);
  }, 1000);
  try {
    // Permission requests must originate directly from the user's click.
    const permitted = automatic || await browser.permissions.request({ origins: MODEL_ORIGINS });
    if (!permitted) throw new Error('Download permission was declined. Bookmarks still work normally.');
    if (version !== epoch) return;
    loadingStatus('Checking WebGPU adapter and shader support…');
    await checkGPU();
    if (version !== epoch) return;
    await claimGPU();
    if (version !== epoch) { releaseLock?.(); releaseLock = null; return; }
    // Do not block initialization on a persistence prompt. unlimitedStorage is
    // already requested; cache retention is best-effort regardless.
    navigator.storage?.persist?.().catch(() => false);
    if (!cached) {
      loadingStatus('Checking available model storage…');
      const estimate = await navigator.storage?.estimate?.();
      if (estimate?.quota && estimate.quota - (estimate.usage || 0) < 3 * 1024 ** 3) throw new Error('Less than 3 GB of browser storage is available. Free space before downloading.');
    }
    loadingStatus('Loading the bundled inference runtime…');
    const { CreateWebWorkerMLCEngine } = await import('./vendor/ai-runtime.js');
    if (version !== epoch) return;
    worker = new Worker(browser.runtime.getURL('vendor/ai-worker.js'), { type: 'module' });
    const ready = waitForWorker(worker);
    loadingStatus('Starting the local AI worker…');
    worker.addEventListener('error', () => {
      if (version !== epoch) return;
      unload(); status('The AI worker failed. Reload the model or update your browser.');
    });
    await ready;
    if (version !== epoch) return;
    loadingStatus('Loading model configuration and preparing the GPU…');
    const loaded = await CreateWebWorkerMLCEngine(worker, MODEL_ID, {
      appConfig: config,
      initProgressCallback: report => {
        if (version !== epoch) return;
        if (Number.isFinite(report.progress) && report.progress > 0) $('chat-progress').value = Math.max(0, Math.min(1, report.progress));
        else $('chat-progress').removeAttribute('value');
        loadingStatus(report.text || 'Loading model…');
      }
    });
    if (version !== epoch) return;
    engine = loaded;
    status('Ready · local WebGPU · uses titles, folders, tags, notes and saved abstracts. No pages are fetched.');
    cached = true; startLabel();
    $('chat-question').disabled = false; $('chat-question').focus();
  } catch (error) {
    if (version !== epoch) return;
    unload(); status(`Could not load local AI: ${error?.message || String(error)}`);
  } finally {
    if (version === epoch) { clearInterval(loadTimer); loading = false; $('chat-progress').hidden = true; controls(); }
  }
}
function message(role, text) {
  const item = document.createElement('article'); item.className = 'chat-message';
  const heading = document.createElement('h3'); heading.textContent = role;
  const content = document.createElement('p'); content.textContent = text;
  item.append(heading, content); $('chat-messages').append(item);
  return { item, content };
}
async function send(event) {
  event.preventDefault();
  const question = $('chat-question').value.trim();
  if (!question || !engine || generating) return;
  const version = epoch;
  generating = true; controls();
  const context = buildChatContext(getRoot(), question, history);
  message('You', question);
  const response = message('Marked', '');
  const details = document.createElement('details');
  const summary = document.createElement('summary'); const withNotes = context.sources.filter(source => source.note).length;
  summary.textContent = `${context.sources.length} bookmarks supplied of ${context.total} · ${context.sources.filter(source => source.abstract).length} with abstracts${withNotes ? ` · ${withNotes} with notes` : ''}`;
  details.append(summary);
  context.sources.forEach((source, index) => {
    const link = document.createElement('a'); link.textContent = `[${index + 1}] ${source.title}`;
    const url = safeURL(source.url);
    if (url) { link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    details.append(link);
  });
  response.item.append(details);
  const log = $('chat-messages');
  log.scrollTop = log.scrollHeight;
  $('chat-question').value = '';
  status('Generating on your GPU…');
  let raw = '', answer = '';
  try {
    const stream = await engine.chat.completions.create({
      messages: context.messages, stream: true, max_tokens: 600,
      temperature: 0.5, extra_body: { enable_thinking: false }
    });
    for await (const chunk of stream) {
      if (version !== epoch) return;
      raw += chunk.choices[0]?.delta?.content || '';
      answer = visibleAnswer(raw);
      // Keep following the reply unless the reader has scrolled up.
      const following = log.scrollHeight - log.scrollTop - log.clientHeight < 32;
      response.content.textContent = answer;
      if (following) log.scrollTop = log.scrollHeight;
    }
    if (version !== epoch) return;
    if (!answer) response.content.textContent = 'No response generated. Try a shorter question.';
    else history.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
    // Keep only a short recent exchange in context, never an unbounded prompt.
    history = history.slice(-4);
    status('Ready · connections are suggestions, not verified page analysis.');
  } catch (error) {
    if (version !== epoch) return;
    response.content.textContent = answer || `Generation failed: ${error.message}`;
    status('Generation failed. Try a shorter question or unload and reload the model.');
  } finally {
    if (version === epoch) { generating = false; controls(); $('chat-question').focus(); }
  }
}
export async function openChat(rootProvider) {
  getRoot = rootProvider;
  $('chat-panel').hidden = false;
  $('chat-toggle').setAttribute('aria-expanded', 'true');
  if (!initialized) {
    initialized = true;
    $('chat-start').addEventListener('click', () => start());
    $('chat-close').addEventListener('click', () => {
      $('chat-panel').hidden = true; $('chat-toggle').setAttribute('aria-expanded', 'false'); $('chat-toggle').focus();
    });
    $('chat-unload').addEventListener('click', () => {
      const question = engine
        ? 'Unload the model? This frees GPU memory. It stays downloaded, so loading it again will not download it.'
        : 'Stop loading the model? Files downloaded so far are kept.';
      if (confirm(question)) unload();
    });
    $('chat-stop').addEventListener('click', () => { engine?.interruptGenerate(); status('Stopping…'); });
    $('chat-form').addEventListener('submit', send);
    // Enter sends; Shift+Enter inserts a newline. Ignore Enter while an IME is composing.
    $('chat-question').addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      $('chat-form').requestSubmit();
    });
    $('chat-clear').addEventListener('click', () => { history = []; $('chat-messages').replaceChildren(); });
    $('chat-delete-model').addEventListener('click', async () => {
      if (!confirm('Remove the downloaded AI model? Bookmarks and previews will not be affected.')) return;
      unload(); loading = true; removing = true; controls();
      try {
        await claimGPU();
        const { deleteModelAllInfoInCache } = await import('./vendor/ai-runtime.js');
        await deleteModelAllInfoInCache(MODEL_ID, config);
        cached = false; startLabel(); status('Downloaded model removed.');
      } catch (error) { status(`Could not remove the model: ${error.message}`); }
      finally { releaseLock?.(); releaseLock = null; loading = false; removing = false; controls(); }
    });
    window.addEventListener('pagehide', unload);
    controls();
    try { await checkGPU(); }
    catch (error) { status(error.message); $('chat-start').disabled = true; return; }
    status('Checking for a downloaded model…');
    cached = await hasCachedModel();
    startLabel();
    if (loading || engine) return;
    if (cached && await browser.permissions.contains({ origins: MODEL_ORIGINS })) start({ automatic: true });
    else status(cached ? 'Model downloaded. Choose Load cached model to chat.' : 'WebGPU features and runtime limits passed. Download / load to test actual inference.');
  }
}

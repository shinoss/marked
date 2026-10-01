import { MODEL_ID, MODEL_ORIGINS, modelConfig } from './ai-config.js';
import { buildChatContext, visibleAnswer } from './ai-context.js';
import { safeURL } from './bookmarks.js';
import { waitForWorker } from './ai-loader.js';
import { validateAdapter } from './ai-capabilities.js';
import { modelStatus, pauseDownload, removeModel, resumeDownload, startDownload, watchDownload } from './model-download.js';

const $ = id => document.getElementById(id);
let initialized = false, getRoot, worker, engine, releaseLock;
let loading = false, generating = false, removing = false, asking = false, gpuError = null, epoch = 0;
// The download, as modelStatus() said and download events since: complete,
// done and total bytes, wanted, active (running in some Marked tab), and
// problem (why it stopped short, when it did).
let model = { complete: false, done: 0, total: null, wanted: false, active: false, problem: null };
// Asked for in this tab: load the model once it's downloaded.
let loadWhenDownloaded = false;
const inView = () => !$('chat-panel').hidden && document.visibilityState === 'visible';
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
const size = bytes => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`;
function timeLeft(seconds) {
  if (seconds < 90) return 'about a minute';
  if (seconds < 3600) return `about ${Math.round(seconds / 60)} minutes`;
  return seconds < 5400 ? 'about an hour' : `about ${Math.round(seconds / 3600)} hours`;
}
// The download is running, or about to: nothing to ask for.
const downloading = () => !model.complete && (model.active || (model.wanted && !model.problem));
// What the panel's download section says before the model is downloaded (manager.html).
let downloadNote;
function controls() {
  const busy = loading || !!engine;
  $('chat-start').textContent = loading ? 'Loading…' : model.complete ? 'Load model' : downloading() ? 'Downloading…' : model.done ? 'Resume download' : 'Download model';
  $('chat-start').disabled = busy || asking || removing || downloading() || !!gpuError;
  // Until the model is loaded, the bottom of the panel is what it takes to
  // chat: the download, or loading it. Then the question box.
  $('chat-download').hidden = !!engine;
  $('chat-form').hidden = !engine;
  $('chat-download-title').textContent = loading ? 'Loading the model…' : model.complete ? 'Load the model to chat' : downloading() ? 'Downloading the model…' : model.done ? 'Finish the download to chat' : 'Download the model to start chatting';
  downloadNote ??= $('chat-download-note').textContent;
  $('chat-download-note').textContent = model.complete ? 'It loads onto your GPU and stays loaded while this tab is open.' : downloadNote;
  // Unload, Remove download, and Clear chat, once there's a model to act on.
  $('chat-model').hidden = !busy && !model.complete && !model.done && !model.wanted;
  // While only downloading, Unload pauses the download.
  $('chat-unload').textContent = !busy && downloading() ? 'Pause' : 'Unload';
  $('chat-unload').disabled = removing || (!busy && !downloading());
  $('chat-question').disabled = !engine || generating;
  $('chat-stop').hidden = !generating;
  $('chat-clear').disabled = generating;
  $('chat-delete-model').disabled = loading || generating || removing || (!model.complete && !model.done && !model.wanted);
}
function showDownload({ done, total, rate, elsewhere }) {
  if (loading || engine) return;
  const progress = $('chat-progress');
  progress.hidden = false;
  if (total) progress.value = Math.min(1, done / total); else progress.removeAttribute('value');
  const left = rate > 0 && total ? `, ${timeLeft((total - done) / rate)} left` : '';
  status(!total ? 'Starting the download…' : `${elsewhere ? 'In another Marked tab: ' : ''}${size(done)} of ${size(total)}${left}. It keeps going while Marked is open.`);
}
function showStopped() {
  $('chat-progress').hidden = true;
  const sofar = model.done ? ` ${size(model.done)} of ${size(model.total)} is on this device.` : '';
  if (model.problem?.reason === 'permission') status(`Marked no longer has access to Hugging Face, which the download needs.${sofar} Choose Resume download to allow it.`);
  else if (model.problem) status(`The download stopped: ${model.problem.message}${sofar} Choose Resume download to try again.`);
  else if (model.done) status(`Download paused.${sofar} Choose Resume download to finish it.`);
  else status('');
}
// Brings the panel up to date with what's on this device. load: load the
// model if it's all downloaded.
async function refresh({ load: loadNow = false } = {}) {
  try {
    const found = await modelStatus();
    model = { ...found, active: found.downloading, problem: model.wanted && found.wanted ? model.problem : null };
  } catch (error) { status(`Could not check for a downloaded model: ${error.message}`); return; }
  controls();
  if (loading || engine) return;
  if (model.complete) {
    $('chat-progress').hidden = true;
    if (loadNow) start(); else status('');
  } else if (downloading()) {
    showDownload({ ...model, elsewhere: model.active && !model.here });
    // A download asked for earlier, that no Marked tab has carried on yet.
    resumeDownload();
  } else showStopped();
}
function onDownload(event) {
  if (event.type === 'progress') {
    model = { ...model, done: event.done, total: event.total ?? model.total, wanted: true, active: true, problem: null };
    controls(); showDownload(event);
  } else if (event.type === 'waiting') {
    if (!loading && !engine) status(`Waiting for an internet connection to carry on the download${model.done ? ` (${size(model.done)} of ${size(model.total)} so far)` : ''}.`);
  } else if (event.type === 'complete') {
    // Where the chat is in view. Where it was asked for, once that tab is.
    refresh({ load: inView() });
  } else if (event.type === 'stopped') {
    model = { ...model, active: false, wanted: event.reason !== 'paused', problem: event.reason === 'paused' ? null : event };
    controls();
    if (!loading && !engine) showStopped();
  } else if (event.type === 'removed') {
    model = { complete: false, done: 0, total: model.total, wanted: false, active: false, problem: null };
    controls();
    if (!loading && !engine) { $('chat-progress').hidden = true; status('Downloaded model removed.'); }
  }
}
// Settles once this tab has let go of the GPU: the browser frees the lock a
// moment after unload() releases it, so Remove download or loading again
// right after would otherwise find it taken.
let gpuFree = Promise.resolve();
async function claimGPU() {
  await gpuFree;
  await new Promise((resolve, reject) => {
    gpuFree = navigator.locks.request('marked-ai-gpu', { ifAvailable: true }, async lock => {
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
// The one ask: the browser's permission to reach Hugging Face, from the click.
// From then on the download carries on by itself until it's done, and the
// model loads when it is.
async function download() {
  if (asking) return;
  asking = true; controls();
  status('Waiting for download permission… Check for a browser permission prompt.');
  try {
    // Permission requests must originate directly from the user's click.
    if (!await browser.permissions.request({ origins: MODEL_ORIGINS })) { status('Download permission was declined. Bookmarks still work normally.'); return; }
    status('Checking WebGPU adapter and shader support…');
    await checkGPU();
    if (!model.done) {
      status('Checking available model storage…');
      const estimate = await navigator.storage?.estimate?.();
      if (estimate?.quota && estimate.quota - (estimate.usage || 0) < 3 * 1024 ** 3) { status('Less than 3 GB of browser storage is available. Free space before downloading.'); return; }
    }
    // Do not block on a persistence prompt. unlimitedStorage is already
    // requested; cache retention is best-effort regardless.
    navigator.storage?.persist?.().catch(() => false);
    loadWhenDownloaded = true;
    model = { ...model, wanted: true, problem: null };
    status('Starting the download…');
    startDownload().catch(error => status(`Could not start the download: ${error.message}`));
  } catch (error) {
    status(`Could not download the model: ${error?.message || String(error)}`);
  } finally { asking = false; controls(); }
}
// Loads the downloaded model onto the GPU, from this device: nothing is fetched.
async function start() {
  if (loading || engine) return;
  loadWhenDownloaded = false;
  const version = ++epoch;
  loading = true; controls();
  $('chat-progress').hidden = false;
  $('chat-progress').removeAttribute('value');
  loadingStatus('Loading the downloaded model from this device…');
  loadTimer = setInterval(() => {
    if (version !== epoch || !loading) return;
    const seconds = Math.floor((Date.now() - lastLoadUpdate) / 1000);
    if (seconds >= 5) status(`${loadStage} (${seconds}s since last update)${seconds >= 60 ? ' No new progress reported. You can cancel with Unload and retry.' : ''}`);
  }, 1000);
  try {
    loadingStatus('Checking WebGPU adapter and shader support…');
    await checkGPU();
    if (version !== epoch) return;
    await claimGPU();
    if (version !== epoch) { releaseLock?.(); releaseLock = null; return; }
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
    status('Ready.');
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
    status('Ready.');
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
    $('chat-start').addEventListener('click', () => model.complete ? start() : download());
    $('chat-close').addEventListener('click', () => {
      $('chat-panel').hidden = true; $('chat-toggle').setAttribute('aria-expanded', 'false'); $('chat-toggle').focus();
    });
    $('chat-unload').addEventListener('click', () => {
      if (!engine && !loading && downloading()) {
        if (confirm('Pause the download? What has downloaded stays on this device, and Resume download carries on from there.')) pauseDownload().catch(error => status(`Could not pause the download: ${error.message}`));
        return;
      }
      const question = engine
        ? 'Unload the model? This frees GPU memory. It stays downloaded, so loading it again will not download it.'
        : 'Stop loading the model? It stays downloaded.';
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
      unload(); removing = true; controls();
      try {
        // Not while another Marked tab is running it.
        await claimGPU();
        await removeModel();
      } catch (error) { status(`Could not remove the model: ${error.message}`); }
      finally { releaseLock?.(); releaseLock = null; removing = false; controls(); }
    });
    window.addEventListener('pagehide', unload);
    // Back to the tab that asked for the download, now that it's done.
    document.addEventListener('visibilitychange', () => { if (loadWhenDownloaded && model.complete && inView()) start(); });
    controls();
    try { await checkGPU(); }
    catch (error) { gpuError = error; status(error.message); controls(); return; }
    watchDownload(onDownload);
    status('Checking for a downloaded model…');
    await refresh({ load: true });
  } else if (loadWhenDownloaded && model.complete) start();
}

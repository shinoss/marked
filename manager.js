import { safeURL, exportHTML, parseHTML, parseJSON } from './bookmarks.js';
import { createLibraryStore, STORAGE_KEY } from './store.js';
import { relativeAge } from './time.js';
const library = createLibraryStore(browser);

const $ = id => document.getElementById(id);
const state = { root: null, nodes: new Map(), folder: null, selected: new Set(), expanded: new Set(), visible: [], editing: null };
let toastTimer, refreshTimer, loadVersion = 0;
let view = 'list';
let pendingPreview = null;
let pendingPreviewURL = null;
const validPreview = value => typeof value === 'string' && value.startsWith('data:image/jpeg;base64,') && value.length < 500000;
const isFolder = node => node && !node.url && node.type !== 'separator';
const protectedNode = node => node.id === state.root.id;
const title = node => node.title || node.url || 'Untitled';
function displayDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') || url; }
  catch { return url; }
}
function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function button(text, action, className, label) {
  const el = element('button', className, text);
  el.type = 'button';
  if (label) { el.title = label; el.setAttribute('aria-label', label); }
  el.addEventListener('click', action);
  return el;
}
function iconButton(kind, action, className, label) {
  const el = button('', action, className, label);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', kind === 'trash'
    ? 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7'
    : 'M14 5l5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14z');
  svg.append(path);
  el.append(svg);
  return el;
}
function toast(message, undo = null) {
  clearTimeout(toastTimer);
  const notice = $('toast');
  notice.replaceChildren(element('span', '', message));
  notice.hidden = false;
  if (undo) {
    const undoButton = button('Undo', async () => {
      undoButton.disabled = true;
      try {
        await undo();
        toast('Restored to Marked.');
      } catch (error) {
        notice.querySelector('span').textContent = `Could not restore: ${error.message}. Try Undo again.`;
        undoButton.disabled = false;
      }
    }, 'toast-action');
    notice.append(undoButton, button('Dismiss', () => { notice.hidden = true; notice.replaceChildren(); }, 'toast-action'));
  } else {
    toastTimer = setTimeout(() => { notice.hidden = true; }, 6000);
  }
}
function fail(error) { toast(error.message || String(error)); }
function ancestors(id) {
  const result = [];
  let node = state.nodes.get(id);
  while (node && node.id !== state.root.id) { result.unshift(node); node = state.nodes.get(node.parentId); }
  return result;
}
function path(id) { return ancestors(id).map(title).join(' / ') || 'Library'; }
function defaultFolder() {
  if (state.folder && isFolder(state.nodes.get(state.folder))) return state.folder;
  return state.root.id;
}
async function load() {
  const version = ++loadVersion;
  const [root] = await library.getTree();
  if (version !== loadVersion) return;
  state.root = root;
  state.nodes.clear();
  function index(node) { state.nodes.set(node.id, node); node.children?.forEach(index); }
  index(root);
  if (state.folder && !state.nodes.has(state.folder)) state.folder = null;
  for (const id of state.selected) if (!state.nodes.has(id)) state.selected.delete(id);
  render();
}
function navigate(id) {
  state.folder = id;
  state.selected.clear();
  $('search').value = '';
  if (id) ancestors(id).forEach(node => state.expanded.add(node.id));
  render();
}
function renderTree() {
  $('folder-tree').replaceChildren();
  $('all-bookmarks').classList.toggle('active', !state.folder);
  $('total').textContent = [...state.nodes.values()].filter(n => n.url).length.toLocaleString();
  function append(node, depth) {
    const row = element('div', 'folder-row');
    row.style.paddingLeft = `${depth * 14}px`;
    const children = (node.children || []).filter(isFolder);
    const expanded = state.expanded.has(node.id);
    const toggle = button(children.length ? (expanded ? '▾' : '▸') : '', () => {
      if (expanded) state.expanded.delete(node.id); else state.expanded.add(node.id);
      renderTree();
    }, 'disclosure', `${expanded ? 'Collapse' : 'Expand'} ${title(node)}`);
    toggle.disabled = !children.length;
    if (children.length) toggle.setAttribute('aria-expanded', String(expanded));
    const link = button('', () => navigate(node.id), `folder-link${state.folder === node.id ? ' active' : ''}`);
    link.title = title(node);
    if (state.folder === node.id) link.setAttribute('aria-current', 'page');
    link.append(element('span', 'folder-name', title(node)), element('span', 'count', (node.children || []).filter(n => n.url).length));
    row.append(toggle, link);
    if (!protectedNode(node)) {
      row.append(
        iconButton('pencil', () => openEditor(node), 'folder-edit', `Edit folder ${title(node)}`),
        iconButton('trash', () => removeItems([node.id]).catch(fail), 'folder-delete', `Delete folder ${title(node)}`)
      );
    }
    $('folder-tree').append(row);
    if (expanded) children.forEach(child => append(child, depth + 1));
  }
  state.root.children.filter(isFolder).forEach(node => append(node, 0));
}
function render() {
  if (!state.root) return;
  renderTree();
  document.querySelector('.table-wrap').classList.toggle('gallery', view === 'gallery');
  $('list-view').setAttribute('aria-pressed', String(view === 'list'));
  $('gallery-view').setAttribute('aria-pressed', String(view === 'gallery'));
  const query = $('search').value.trim().toLowerCase();
  const current = state.nodes.get(state.folder);
  const showLocation = !current;
  document.querySelector('.location-column').hidden = !showLocation;
  let nodes = query ? [...state.nodes.values()].filter(node => node.id !== state.root.id && node.type !== 'separator' && `${title(node)} ${node.url || ''} ${path(node.parentId)}`.toLowerCase().includes(query))
    : current ? [...(current.children || [])].filter(n => n.type !== 'separator') : [...state.nodes.values()].filter(n => n.url);
  const sort = $('sort').value;
  if (sort !== 'default') nodes.sort((a, b) => Number(isFolder(b)) - Number(isFolder(a)) || (sort === 'title' ? title(a).localeCompare(title(b)) : (b.dateAdded || 0) - (a.dateAdded || 0)));
  state.visible = nodes;
  const visibleIds = new Set(nodes.map(n => n.id));
  for (const id of state.selected) if (!visibleIds.has(id)) state.selected.delete(id);
  $('page-title').textContent = query ? 'Search results' : current ? title(current) : 'All bookmarks';
  $('breadcrumbs').replaceChildren(button('Library', () => navigate(null)));
  if (current) for (const node of ancestors(current.id)) $('breadcrumbs').append(element('span', '', '/'), button(title(node), () => navigate(node.id)));
  const fragment = document.createDocumentFragment();
  for (const node of nodes) {
    const row = element('tr', state.selected.has(node.id) ? 'selected' : '');
    const checkCell = element('td', 'check-cell');
    const check = element('input'); check.type = 'checkbox'; check.checked = state.selected.has(node.id); check.disabled = protectedNode(node);
    check.setAttribute('aria-label', `Select ${title(node)}`);
    check.addEventListener('change', () => { if (check.checked) state.selected.add(node.id); else state.selected.delete(node.id); row.classList.toggle('selected', check.checked); renderSelection(); });
    checkCell.append(check);
    const nameCell = element('td');
    const main = element('div', 'item-main');
    const text = element('div', 'item-text');
    let link;
    if (isFolder(node)) link = button(title(node), () => navigate(node.id), 'item-title');
    else {
      link = element('a', 'item-title', title(node));
      const url = safeURL(node.url);
      if (url) { link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; }
      else { link.title = 'This URL cannot be opened here. Use Firefox’s native manager for special bookmark URLs.'; }
    }
    link.title ||= title(node);
    const metadata = element('div', 'item-metadata');
    const domain = element('span', 'item-url', isFolder(node) ? `${node.children?.length || 0} items` : displayDomain(node.url));
    if (node.url) domain.title = node.url;
    metadata.append(domain);
    const age = relativeAge(node.dateAdded);
    if (age) {
      const added = element('time', 'item-age', age);
      added.dateTime = new Date(node.dateAdded).toISOString();
      added.title = new Date(node.dateAdded).toLocaleString();
      metadata.append(added);
    }
    text.append(link, metadata);
    const preview = element('div', 'card-preview');
    if (validPreview(node.preview)) {
      const image = element('img'); image.src = node.preview; image.alt = ''; image.loading = 'lazy';
      preview.append(image);
    } else preview.append(element('span', '', isFolder(node) ? 'Folder' : 'No preview'));
    main.append(preview, text); nameCell.append(main);
    const location = element('td', 'item-location', path(node.parentId)); location.title = path(node.parentId);
    const actions = element('td', 'row-actions');
    if (!protectedNode(node)) actions.append(iconButton('pencil', () => openEditor(node), 'item-action', `Edit ${title(node)}`), iconButton('trash', () => removeItems([node.id]).catch(fail), 'item-action', `Delete ${title(node)}`));
    row.append(checkCell, nameCell);
    if (showLocation) row.append(location);
    row.append(actions); fragment.append(row);
  }
  $('items').replaceChildren(fragment);
  document.querySelector('.table-wrap').hidden = nodes.length === 0;
  $('empty').hidden = nodes.length > 0;
  $('empty').querySelector('h2').textContent = query ? 'No bookmarks found' : 'No bookmarks yet';
  $('empty').querySelector('p').textContent = query ? 'Try another name, URL, or folder.' : 'Add a bookmark or import your saved collection.';
  $('visible-count').textContent = `${nodes.length.toLocaleString()} ${nodes.length === 1 ? 'item' : 'items'}`;
  renderSelection();
}
function renderSelection() {
  const count = state.selected.size;
  $('selection-tools').hidden = !count;
  $('list-label').hidden = !!count;
  $('selection-count').textContent = `${count} selected`;
  const selectable = state.visible.filter(n => !protectedNode(n));
  $('select-all').checked = selectable.length > 0 && count === selectable.length;
  $('select-all').indeterminate = count > 0 && count < selectable.length;
  $('select-all').disabled = !selectable.length;
}
function fillFolders(select, excluded = new Set(), selected = defaultFolder()) {
  select.replaceChildren();
  function append(node, depth) {
    if (!isFolder(node) || excluded.has(node.id)) return;
    const option = element('option', '', `${'　'.repeat(depth)}${title(node)}`);
    option.value = node.id; select.append(option);
    node.children?.forEach(child => append(child, depth + 1));
  }
  const rootOption = element('option', '', 'Library (top level)');
  rootOption.value = state.root.id;
  select.append(rootOption);
  state.root.children.forEach(node => append(node, 1));
  if ([...select.options].some(o => o.value === selected)) select.value = selected;
}
function openEditor(node = null, folder = false) {
  state.editing = node;
  pendingPreview = validPreview(node?.preview) ? node.preview : null;
  pendingPreviewURL = node?.url || null;
  showEditorPreview();
  const isDir = node ? isFolder(node) : folder;
  $('editor-title').textContent = `${node ? 'Edit' : 'New'} ${isDir ? 'folder' : 'bookmark'}`;
  $('edit-name').value = node?.title || '';
  $('edit-url').value = node?.url || '';
  $('url-field').hidden = isDir;
  $('edit-url').required = !isDir;
  $('editor-error').textContent = '';
  fillFolders($('edit-parent'), new Set(node ? [node.id] : []), node?.parentId || defaultFolder());
  $('editor').showModal(); $('edit-name').focus();
}
function showEditorPreview() {
  $('preview-field').hidden = !pendingPreview;
  $('save-preview').checked = !!pendingPreview;
  if (pendingPreview) $('edit-preview').src = pendingPreview;
  else $('edit-preview').removeAttribute('src');
}
async function confirmAction(heading, message, accept) {
  $('confirm-title').textContent = heading; $('confirm-message').textContent = message; $('confirm-accept').textContent = accept;
  const dialog = $('confirm-dialog'); dialog.returnValue = '';
  return new Promise(resolve => { dialog.addEventListener('close', () => resolve(dialog.returnValue === 'accept'), { once: true }); dialog.showModal(); });
}
function topLevelIds(ids) {
  const set = new Set(ids);
  return ids.filter(id => { const node = state.nodes.get(id); return node && !protectedNode(node) && !ancestors(node.parentId).some(parent => set.has(parent.id)); });
}
async function removeItems(ids) {
  ids = topLevelIds(ids);
  if (!ids.length) return;
  const single = ids.length === 1 ? state.nodes.get(ids[0]) : null;
  const folder = single && isFolder(single);
  function descendants(node) {
    return (node.children || []).reduce((count, child) => count + 1 + descendants(child), 0);
  }
  const childCount = ids.reduce((count, id) => count + descendants(state.nodes.get(id)), 0);
  const subject = single ? `“${title(single)}”` : `${ids.length} selected items`;
  const contents = childCount ? ` This also deletes all ${childCount} nested items, including every bookmark and subfolder inside. Are you OK with deleting all of them?` : '';
  if (!await confirmAction(folder ? 'Delete folder?' : 'Delete bookmarks?', `Delete ${subject} from Marked?${contents} Firefox bookmarks will not change. You can undo using the message shown after deletion.`, folder ? 'Delete folder' : 'Delete')) return;
  const deleted = await library.removeMany(ids);
  state.selected.clear(); await load();
  toast('Deleted from Marked.', async () => {
    await library.restoreMany(deleted);
    await load();
  });
}
$('editor-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = event.submitter; submit.disabled = true;
  try {
    const name = $('edit-name').value.trim();
    if (!name) throw new Error('Enter a name.');
    const folder = $('url-field').hidden;
    const url = folder ? undefined : safeURL($('edit-url').value.trim());
    if (!folder && !url) throw new Error('Use an http, https, ftp, or file URL.');
    const changes = { title: name, ...(folder ? {} : { url }) };
    if (pendingPreview) {
      changes.preview = !folder && $('save-preview').checked && url === pendingPreviewURL ? pendingPreview : null;
    }
    const parentId = $('edit-parent').value;
    if (state.editing) {
      await library.update(state.editing.id, changes, parentId);
    } else await library.create({ ...changes, parentId, type: folder ? 'folder' : 'bookmark' });
    $('editor').close(); await load(); toast('Saved to Marked.');
  } catch (error) { $('editor-error').textContent = error.message; }
  finally { submit.disabled = false; }
});
$('move-selected').addEventListener('click', () => {
  fillFolders($('move-parent'), state.selected); $('move-error').textContent = ''; $('move-dialog').showModal();
});
$('move-form').addEventListener('submit', async event => {
  event.preventDefault(); event.submitter.disabled = true;
  try {
    const parentId = $('move-parent').value;
    if (!parentId) throw new Error('Choose a destination folder.');
    await library.moveMany(topLevelIds([...state.selected]), parentId);
    $('move-dialog').close(); state.selected.clear(); await load(); toast('Items moved.');
  } catch (error) { $('move-error').textContent = error.message; }
  finally { event.submitter.disabled = false; }
});
$('export').addEventListener('click', () => {
  const blob = new Blob([exportHTML(state.root)], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = element('a'); link.href = url; link.download = `marked-bookmarks-${new Date().toISOString().slice(0, 10)}.html`;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  toast('Exported your complete bookmark collection.');
});
$('import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async () => {
  const file = $('import-file').files[0]; $('import-file').value = '';
  if (!file) return;
  try {
    if (file.size > 25 * 1024 * 1024) throw new Error('Choose a bookmark export smaller than 25 MB.');
    const text = await file.text();
    const { nodes, skipped } = file.name.toLowerCase().endsWith('.json') ? parseJSON(text) : parseHTML(text);
    if (!nodes.length) throw new Error('No supported bookmarks or folders found.');
    let count = 0; const countNodes = list => list.forEach(n => { count++; if (n.children) countNodes(n.children); }); countNodes(nodes);
    const parentId = defaultFolder();
    if (!await confirmAction('Import bookmarks?', `Add ${count.toLocaleString()} items in a new “Imported” folder under ${path(parentId)}? Existing bookmarks are kept; duplicates are not merged.${skipped ? ` ${skipped} unsupported items will be skipped.` : ''}`, 'Import')) return;
    $('import').disabled = true;
    const container = await library.importTree(nodes, parentId, `Imported · ${new Date().toLocaleDateString()}`);
    await load(); navigate(container.id); toast(`Imported ${count.toLocaleString()} items${skipped ? `; skipped ${skipped} unsupported items` : ''}.`);
  } catch (error) {
    fail(error);
  } finally { $('import').disabled = false; load().catch(fail); }
});
$('all-bookmarks').addEventListener('click', () => navigate(null));
$('new-bookmark').addEventListener('click', () => openEditor());
$('new-folder').addEventListener('click', () => openEditor(null, true));
$('sidebar-add').addEventListener('click', () => openEditor(null, true));
let searchTimer;
$('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.selected.clear(); render(); }, 120); });
$('sort').addEventListener('change', render);
for (const mode of ['list', 'gallery']) $(mode + '-view').addEventListener('click', () => {
  view = mode; render();
  browser.storage.local.set({ markedView: mode }).catch(fail);
});
$('editor').addEventListener('close', () => {
  pendingPreview = null; pendingPreviewURL = null; showEditorPreview();
});
$('select-all').addEventListener('change', () => { state.selected = new Set($('select-all').checked ? state.visible.filter(n => !protectedNode(n)).map(n => n.id) : []); render(); });
$('clear-selection').addEventListener('click', () => { state.selected.clear(); render(); });
$('delete-selected').addEventListener('click', () => removeItems([...state.selected]).catch(fail));
document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => $(el.dataset.close).close()));
document.addEventListener('keydown', event => {
  if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !document.querySelector('dialog[open]') && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) { event.preventDefault(); $('search').focus(); }
});
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) {
    clearTimeout(refreshTimer); refreshTimer = setTimeout(() => load().catch(fail), 200);
  }
});
Promise.all([load(), browser.storage.local.get('markedView').then(saved => {
  view = saved.markedView === 'gallery' ? 'gallery' : 'list';
})]).then(async () => {
  render();
  const params = new URLSearchParams(document.location.search);
  if (!params.has('add')) return;
  const url = safeURL(params.get('add'));
  // Consume the request so refreshing the tab does not reopen the dialog.
  document.defaultView.history.replaceState(null, '', document.location.pathname);
  if (!url) { toast('This page URL cannot be bookmarked.'); return; }
  openEditor();
  $('edit-name').value = params.get('title') || url;
  $('edit-url').value = url;
  const key = params.get('preview');
  if (key?.startsWith('preview-')) {
    try {
      const capture = (await browser.storage.session.get(key))[key];
      await browser.storage.session.remove(key);
      if ($('editor').open && capture?.url === url && Date.now() - capture.createdAt < 60000 && validPreview(capture.preview)) {
        pendingPreview = capture.preview; pendingPreviewURL = url; showEditorPreview();
      }
    } catch { /* Preview is optional; the bookmark can still be saved. */ }
  }
}).catch(fail);

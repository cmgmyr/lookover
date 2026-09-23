import { homedir } from 'node:os';
import { basename, dirname, sep } from 'node:path';

import { accentInk, accentOnDark, accentOnLight, safeAccent } from './accent.ts';
import { MAX_FILE_BYTES, MAX_FILES } from './files.ts';
import { renderMarkdown } from './markdown.ts';
import type { Counts, FileRow, FileSide, Item, Project } from './store.ts';

export interface PageView {
  projects: Project[];
  /** The same projects, busiest first; the tiles are the head of this list. */
  byActivity?: Project[];
  current: string;
  open: Item[];
  waiting: Item[];
  done: Item[];
  counts: Map<number, Counts>;
  retestVerdicts?: Map<number, string | null>;
  files?: Map<number, FileRow[]>;
  token?: string;
}

/** What one card needs of a view: the same inputs the page gives every card in it. */
export type CardView = Pick<PageView, 'projects' | 'current' | 'retestVerdicts' | 'files' | 'token'>;

export function renderPage(view: PageView): string {
  const currentProject = view.projects.find((project) => project.slug === view.current);
  const title = currentProject === undefined ? 'All projects' : currentProject.name;
  const accent = safeAccent(currentProject?.accent);
  const token = tokenQuery(view);
  const tokenValue = tokenField(view);
  const viewValue = viewField(view);
  const allOpen = allOpenCount(view);
  const shownTiles = tileProjects(view);
  const picker = tiles(view, shownTiles, token, allOpen) + jump(view, shownTiles, token, allOpen);
  const baseTitleText = `${title} · Lookover`;
  const titleText = view.open.length > 0 ? `(${view.open.length}) ${baseTitleText}` : baseTitleText;

  const projectOptions = currentProject === undefined && view.projects.length > 1
    ? `<label for="new-project">Project</label><select id="new-project" name="project">${byName(view.projects).map((project) => `<option value="${escapeHtml(project.slug)}">${escapeHtml(project.name)}</option>`).join('')}</select>`
    : currentProject === undefined && view.projects.length === 1
      ? `<input type="hidden" name="project" value="${escapeHtml(view.projects[0]?.slug ?? '')}">`
    : '';
  const projectQuery = view.current === 'all' ? 'all' : encodeURIComponent(view.current);
  const pollToken = view.token === undefined ? '' : `&t=${encodeURIComponent(view.token)}`;
  const newSection = view.projects.length === 0
    ? '<section><p class="empty">No projects registered. Run <code>lookover init --name &lt;name&gt;</code> first.</p></section>'
    : `<section><details class="fold filer"><summary>Found something else?${CHEVRON}</summary><form class="card" method="post" enctype="multipart/form-data" action="/items/new${token}">${currentProject === undefined ? projectOptions : `<input type="hidden" name="project" value="${escapeHtml(currentProject?.slug ?? '')}">`}${tokenValue}${viewValue}<label for="new-title">Title</label><input id="new-title" name="title" required maxlength="200" placeholder="Short name for what you found"><label for="new-body">What you saw</label><textarea id="new-body" name="body" placeholder="Where you were, what happened, what you expected."></textarea>${photoInput('new-photo')}<button type="submit">Send to the agent</button></form></details></section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(titleText)}</title>${favicon(accent)}<style>${themeVars(accent)}${STYLE}</style></head><body><main>
<header>${wordmark()}<h1>${escapeHtml(title)}</h1>${currentProject === undefined ? '' : `<p class="sub">${escapeHtml(placeLine(currentProject.root))}</p>`}</header>
<nav aria-label="Projects" class="picker">${picker}</nav>
<p id="new-count" class="new-count" hidden><a href=""></a></p>
${newSection}
<section><h2 data-section="open">Awaiting your test<span class="n">${view.open.length}</span></h2>${view.open.length === 0 ? `<p class="empty">${doneMark()}Nothing to test. A real and good state.</p>` : grouped(view, view.open).map((item) => renderCard(view, item, false)).join('')}</section>
<section><h2 data-section="feedback">Waiting for the agent<span class="n">${view.waiting.length}</span></h2>${view.waiting.length === 0 ? '<p class="none">Nothing saved yet.</p>' : grouped(view, view.waiting).map((item) => renderCard(view, item, true)).join('')}</section>
<section><h2>Processed<span class="n">${view.done.length}</span></h2>${view.done.length === 0 ? '<p class="none">Nothing processed yet.</p>' : `<details class="fold history"><summary>Show history${CHEVRON}</summary>${grouped(view, view.done).map((item) => `<div class="done" id="item-${item.id}"><strong>${escapeHtml(item.title)}</strong> <span class="badge ${escapeHtml(item.verdict ?? 'note')}">${escapeHtml(verdictLabel(item.verdict))}</span><div class="meta">${escapeHtml(item.processed_at ?? '')}${item.processed_note ? ` · ${escapeHtml(item.processed_note)}` : ''}</div></div>`).join('')}</details>`}</section>
</main><div id="toast" class="toast" role="status"></div>${pollScript(projectQuery, pollToken, view.open.length, baseTitleText)}</body></html>`;
}

function tokenQuery(view: CardView): string {
  return view.token === undefined ? '' : `?t=${encodeURIComponent(view.token)}`;
}

function tokenField(view: CardView): string {
  return view.token === undefined ? '' : `<input type="hidden" name="t" value="${escapeHtml(view.token)}">`;
}

// no-referrer is set on this page on purpose, so a POST carries no Referer
// and the server cannot tell which view to send the tester back to. The
// form says it.
function viewField(view: CardView): string {
  return `<input type="hidden" name="view" value="${escapeHtml(view.current)}">`;
}

/** One card, as the page renders it in its section; the JSON save routes send this back. */
export function renderCard(view: CardView, item: Item, waiting: boolean): string {
  return card(item, tokenQuery(view), tokenField(view) + viewField(view), waiting, view.retestVerdicts, projectBadge(view, item), cardAccent(view, item), view.files);
}

/** Every accent reaches the CSS as four validated hexes: a fill and its ink, per theme. */
function accentVars(accent: string): string {
  const light = accentOnLight(accent);
  const dark = accentOnDark(accent);
  return `--bl:${light};--bil:${accentInk(light)};--bd:${dark};--bid:${accentInk(dark)}`;
}

function themeVars(accent: string): string {
  const light = accentOnLight(accent);
  const dark = accentOnDark(accent);
  return `:root{--page-accent:${light};--page-ink:${accentInk(light)}}@media(prefers-color-scheme:dark){:root{--page-accent:${dark};--page-ink:${accentInk(dark)}}}`;
}

function favicon(accent: string): string {
  return `<link rel="icon" href="${lensIcon(accentOnLight(accent), BRAND_INK)}"><link rel="icon" media="(prefers-color-scheme:dark)" href="${lensIcon(accentOnDark(accent), BRAND_INK_DARK)}">`;
}

/** lookover's own colour, the app's and never a project's: the header mark wears it. */
const BRAND = '#B86BF0';
const BRAND_INK = '#1F2937';
const BRAND_INK_DARK = '#E6EDF3';

/**
 * The 16px mark: a lens over one ruled line, in a 100 box. One function, so
 * the favicon, the header and docs/assets/logo-mark-small.svg cannot drift apart.
 */
export function markShapes(ring: string, ink: string): string {
  return `<g stroke-linecap="round" stroke-linejoin="round"><circle cx="40" cy="40" r="29" fill="none" stroke="${ring}" stroke-width="15"/><path d="M63 63L90 90" fill="none" stroke="${ring}" stroke-width="17"/><path d="M30 40L50 40" fill="none" stroke="${ink}" stroke-width="11"/></g>`;
}

/** A tick on the accent, for the one empty state that is good news. */
function doneMark(): string {
  return '<svg class="done-mark" width="44" height="44" viewBox="0 0 32 32" aria-hidden="true"><rect x="3" y="3" width="26" height="26" rx="8" fill="var(--accent)"/><path d="M10.5 16.5l3.8 3.8 7.4-8" fill="none" stroke="var(--accent-ink)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

function lensIcon(ring: string, ink: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${markShapes(ring, ink)}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * The product's name, above the project's. Small and muted on purpose: the
 * page belongs to lookover, but the thing the tester is looking at is the
 * project, and the h1 is the project's.
 */
function wordmark(): string {
  return `<p class="brand"><svg class="mark" width="17" height="17" viewBox="0 0 100 100" aria-hidden="true">${markShapes(BRAND, 'var(--ink)')}</svg>lookover</p>`;
}

/** The directory this project lives in, as a phone glance can read it. */
function placeLine(root: string): string {
  const name = basename(root);
  if (name === '') return root;
  const parent = shortenHome(dirname(root));
  return parent === '' || parent === name ? name : `${name} · ${parent}`;
}

function shortenHome(path: string): string {
  const home = homedir();
  return home !== '' && (path === home || path.startsWith(`${home}${sep}`)) ? `~${path.slice(home.length)}` : path;
}

/**
 * Four tiles at most: All, then the three busiest projects, then the current
 * one if it is not already among them. A dozen registered projects used to
 * fill the row; the rest are in the select beside it.
 */
const TILE_COUNT = 3;

function openCount(view: PageView, project: Project): number {
  return view.counts.get(project.id)?.open ?? 0;
}

/** The same total the All tile and the select's "All projects" option show. */
function allOpenCount(view: PageView): number {
  return view.projects.reduce((sum, project) => sum + openCount(view, project), 0);
}

/**
 * Ranked by open count, busiest first; Array#sort is stable, so ties keep
 * view.byActivity's recency order. Projects with nothing open get no tile,
 * so a quiet store never spends a slot on a project with no work to show.
 */
function tileProjects(view: PageView): Project[] {
  const ranked = view.byActivity ?? view.projects;
  const shown = [...ranked]
    .sort((first, second) => openCount(view, second) - openCount(view, first))
    .filter((project) => openCount(view, project) > 0)
    .slice(0, TILE_COUNT);
  const current = view.projects.find((project) => project.slug === view.current);
  if (current !== undefined && !shown.some((project) => project.id === current.id)) shown.push(current);
  return shown;
}

function tiles(view: PageView, shown: Project[], token: string, allOpen: number): string {
  const all = `<a class="tile all${view.current === 'all' ? ' selected' : ''}" href="/all${token}"><span class="t">All</span><span class="n" data-count-for="all">${allOpen}</span></a>`;
  return `<div class="tiles">${all}${shown.map((project) => tile(project, view, token)).join('')}</div>`;
}

function tile(project: Project, view: PageView, token: string): string {
  const open = openCount(view, project);
  const selected = view.current === project.slug;
  return `<a style="${accentVars(safeAccent(project.accent))}" class="tile${selected ? ' selected' : ''}" href="/p/${encodeURIComponent(project.slug)}${token}"><span class="t">${escapeHtml(project.name)}</span><span class="n" data-count-for="${escapeHtml(project.slug)}">${open}</span></a>`;
}

/**
 * Every project, including the ones with no tile. The form works with no
 * JavaScript at all through its Go button; the poll script hides the button
 * and navigates on change, which is the only other script on this page.
 *
 * It is left out entirely when the tiles already reach every project, because
 * a select that can only repeat what is one tap above it is a row of chrome
 * saying nothing. Most stores have two or three projects and never see it.
 */
function jump(view: PageView, shown: Project[], token: string, allOpen: number): string {
  if (view.projects.length === 0) return '';
  if (view.projects.every((project) => shown.some((tiled) => tiled.id === project.id))) return '';
  const label = (name: string, open: number): string => open > 0 ? `${name} (${open})` : name;
  const option = (value: string, name: string, open: number, openFor: string): string =>
    `<option value="${escapeHtml(value)}" data-name="${escapeHtml(name)}" data-open-for="${escapeHtml(openFor)}"${value === view.current ? ' selected' : ''}>${escapeHtml(label(name, open))}</option>`;
  const options = [option('all', 'All projects', allOpen, 'all')]
    .concat(byName(view.projects).map((project) => option(project.slug, project.name, openCount(view, project), project.slug))).join('');
  const tokenField = view.token === undefined ? '' : `<input type="hidden" name="t" value="${escapeHtml(view.token)}">`;
  return `<form class="jump" method="get" action="/"><label for="jump-project">Go to project</label><select id="jump-project" name="project">${options}</select>${tokenField}<button class="go" type="submit">Go</button></form>`;
}

/**
 * Every select on this page is ordered by the name it shows. The store hands
 * projects over sorted by slug, and a slug never moves once registered, so a
 * project renamed with `lookover init --name` keeps its old slug and sorting
 * on it puts the list out of alphabetical order in the only column the tester
 * can read.
 */
function byName(projects: Project[]): Project[] {
  return [...projects].sort((first, second) => first.name.localeCompare(second.name));
}

function projectBadge(view: CardView, item: Item): string {
  if (view.current !== 'all') return '';
  const project = view.projects.find((entry) => entry.id === item.project_id);
  return project === undefined ? '' : `<span class="project-badge">${escapeHtml(project.name)}</span>`;
}

/**
 * All view lists several projects at once, so its cards are grouped by
 * project name before they are rendered. Array#sort is stable, so each
 * project's cards keep the order the store gave them: the lead's sort key,
 * then id.
 */
function grouped(view: PageView, items: Item[]): Item[] {
  if (view.current !== 'all') return items;
  const name = (id: number): string => view.projects.find((project) => project.id === id)?.name ?? '';
  return [...items].sort((first, second) => name(first.project_id).localeCompare(name(second.project_id)));
}

/** In All view a card is one project's, so it brings that project's accent with it. */
function cardAccent(view: CardView, item: Item): string {
  if (view.current !== 'all') return '';
  const project = view.projects.find((entry) => entry.id === item.project_id);
  return project === undefined ? '' : ` style="${accentVars(safeAccent(project.accent))}"`;
}

function card(item: Item, token: string, tokenValue: string, waiting: boolean, retestVerdicts: Map<number, string | null> | undefined, projectBadge: string, accentStyle: string, files: Map<number, FileRow[]> | undefined): string {
  const meta = [item.source, item.ref].filter((value) => value !== null && value !== '').map((value) => escapeHtml(value ?? ''));
  if (item.url !== null && !isWebUrl(item.url)) meta.push(escapeHtml(item.url));
  if (waiting && item.feedback_at !== null) meta.push(`saved ${escapeHtml(item.feedback_at)}`);
  const priority = priorityBadge(item.sort);
  const source = `<p class="source"><span class="id">#${item.id}</span>${meta.length === 0 ? '' : ` · ${meta.join(' · ')}`}</p>`;
  const open = item.url !== null && isWebUrl(item.url) ? `<a class="open" href="${escapeHtml(item.url)}" rel="noopener noreferrer">${escapeHtml(item.url)}${LEAVES_PAGE}</a>` : '';
  const retest = item.retest_of === null ? '' : `<p class="retest">previously: ${escapeHtml(verdictLabel(retestVerdicts?.get(item.retest_of) ?? null))} on <a href="#item-${item.retest_of}">#${item.retest_of}</a></p>`;
  const body = waiting
    ? (item.feedback === null || item.feedback === '' ? '' : `<div class="quote">${escapeHtml(item.feedback)}</div>`)
    : `<div class="details">${renderMarkdown(item.details)}</div>`;
  const strip = shots(files?.get(item.id) ?? [], waiting ? 'feedback' : 'card', token);
  // The buttons come last because each one sends the form: you write, then
  // the verdict you tap submits what you wrote.
  const answer = `<textarea name="feedback" required placeholder="What you saw, what felt wrong, what to change.">${waiting ? escapeHtml(item.feedback ?? '') : ''}</textarea>${photoInput(`photo-${item.id}`)}${tokenValue}<div class="verdict-row">${ANSWERS.map((value) => `<button class="verdict ${value}${waiting && value === (item.verdict ?? 'note') ? ' selected' : ''}" type="submit" name="verdict" value="${value}"${value === 'approved' ? ' formnovalidate' : ''}>${escapeHtml(verdictLabel(value))}</button>`).join('')}</div>`;
  const chips = `${priority}${projectBadge}${waiting ? `<span class="badge ${escapeHtml(item.verdict ?? 'note')}">${escapeHtml(verdictLabel(item.verdict ?? 'note'))}</span>` : ''}`;
  // Above the title, not inside it: inline chips made the title wrap around
  // them and the project badge land mid-sentence.
  const tags = chips === '' ? '' : `<p class="tags">${chips}</p>`;
  return `<form${accentStyle} class="card" id="item-${item.id}" method="post" enctype="multipart/form-data" action="/items/${item.id}/feedback${token}">${tags}<h3>${escapeHtml(item.title)}</h3>${source}${open}${retest}${body}${strip}${waiting ? `<details class="fold answer"><summary>Change your answer${CHEVRON}</summary><div class="reply">${answer}</div></details>` : `<div class="reply">${answer}</div>`}</form>`;
}

/**
 * The lead's sort key, said out loud. 1 and 2 are the only values the queue
 * order distinguishes; anything else is the ordinary queue and says nothing.
 */
function priorityBadge(sort: number | null): string {
  if (sort === 1) return '<span class="prio first">Blocking</span>';
  if (sort === 2) return '<span class="prio">Soon</span>';
  return '';
}

/**
 * One button for one action. The label IS the button and the native one is
 * hidden, because a styled "Add photo" above the browser's own "Choose Files"
 * is two buttons doing the same job, once per card. The input still renders
 * its own status text ("1 photo selected" on iOS), which is the only way to
 * say what was picked without JavaScript.
 */
function photoInput(id: string): string {
  return `<label class="photo" for="${id}">${PLUS}Add photo</label><input id="${id}" class="photo-input" type="file" name="photo" accept="image/jpeg,image/png,image/webp,image/gif" multiple><div class="picks" hidden></div>`;
}

/** Thumbnails are the full file sized by CSS; a tap opens it at full size. */
function shots(files: FileRow[], side: FileSide, token: string): string {
  const own = files.filter((file) => file.side === side);
  if (own.length === 0) return '';
  const images = own.map((file) => `<a href="/files/${file.id}${token}"><img src="/files/${file.id}${token}" alt="${escapeHtml(file.name)}" loading="lazy"></a>`).join('');
  return `<div class="shots">${images}</div>`;
}

/**
 * The two verdicts a card offers. Note stays a stored verdict (filed cards are
 * born with it, and history and badges still show it) but is not a button:
 * every note left on an agent's card was a needs-work or an approval.
 */
const ANSWERS = ['approved', 'needs-work'] as const;

function verdictLabel(value: string | null): string {
  return value === 'needs-work' ? 'Needs work' : value === 'approved' ? 'Approved' : 'Note';
}

function isWebUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}

/** A JS string literal safe inside an inline <script>: a project name could contain "</script>". */
function scriptString(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003C');
}

export function newCardsLine(delta: number): string | undefined {
  if (delta <= 0) return undefined;
  return `${delta} new card${delta === 1 ? '' : 's'}, reload`;
}

function pollScript(project: string, token: string, initialOpen: number, baseTitle: string): string {
  return `<script>(()=>{const f=document.querySelector('.jump');if(!f)return;const g=f.querySelector('.go');g.hidden=true;f.querySelector('select').addEventListener('change',()=>f.submit())})();let initial=${initialOpen};const baseTitle=${scriptString(baseTitle)};const setTitle=(n)=>{document.title=n>0?'('+n+') '+baseTitle:baseTitle};setInterval(async()=>{try{const r=await fetch('/api/counts?project=${project}${token}');if(!r.ok)return;const n=await r.json();setTitle(n.open);const line=document.getElementById('new-count');const delta=n.open-initial;if(delta>0){line.querySelector('a').textContent=delta===1?'1 new card, reload':delta+' new cards, reload';line.hidden=false}else{line.hidden=true}}catch{}} ,30000);${SAVE_SCRIPT(project)}</script>`;
}

/**
 * Progressive enhancement: with no script every form still posts and redirects.
 * Nothing here may scroll or navigate. A successful save resets the poll's
 * baseline to the server count, so only cards added after that save appear.
 */
const SAVE_SCRIPT = (project: string) => `
const toastEl=document.getElementById('toast');let toastTimer;
const say=(text)=>{clearTimeout(toastTimer);toastEl.textContent=text;toastEl.classList.add('show');toastTimer=setTimeout(()=>toastEl.classList.remove('show'),2500)};
const maxFiles=${MAX_FILES};const maxBytes=${MAX_FILE_BYTES};
const picksFor=(form)=>form.querySelector('.picks');
const photoFor=(form)=>form.querySelector('.photo-input');
const fileLabel=(file)=>file.name||'Pasted image';
const clearPicks=(form)=>{const picks=picksFor(form);if(!picks)return;for(const image of picks.querySelectorAll('img'))URL.revokeObjectURL(image.src);picks.replaceChildren();picks.hidden=true};
const renderPicks=(form)=>{const input=photoFor(form),picks=picksFor(form);if(!input||!picks)return;clearPicks(form);const files=[...input.files];if(files.length===0)return;for(const [index,file] of files.entries()){const image=document.createElement('img');image.src=URL.createObjectURL(file);image.alt=fileLabel(file);const remove=document.createElement('button');remove.type='button';remove.className='pick-remove';remove.dataset.index=String(index);remove.textContent='Remove';const row=document.createElement('div');row.className='pick';row.append(image,document.createElement('span'),remove);row.querySelector('span').textContent=fileLabel(file);picks.append(row)}picks.hidden=false};
const attachFiles=(form,files)=>{const input=photoFor(form);if(!input||files.length===0)return;const current=[...input.files];if(current.length+files.length>maxFiles){say('too many files: '+(current.length+files.length)+' sent, '+maxFiles+' allowed at once');return}const tooLarge=files.find((file)=>file.size>maxBytes);if(tooLarge){say(fileLabel(tooLarge)+' is '+(tooLarge.size/1024/1024).toFixed(1)+' MB; the limit is '+(maxBytes/1024/1024)+' MB per file');return}if(typeof DataTransfer==='undefined'){say('Could not attach pasted photos in this browser.');return}const transfer=new DataTransfer();for(const file of [...current,...files])transfer.items.add(file);input.files=transfer.files;renderPicks(form)};
document.addEventListener('change',(event)=>{const input=event.target;if(!(input instanceof HTMLInputElement)||!input.matches('.photo-input'))return;renderPicks(input.closest('form.card'))});
document.addEventListener('paste',(event)=>{const target=event.target;const form=target instanceof Element?target.closest('form.card'):null;if(!form)return;const files=[...(event.clipboardData?.files??[])].filter((file)=>file.type.startsWith('image/'));if(files.length===0)return;event.preventDefault();attachFiles(form,files)});
document.addEventListener('click',(event)=>{const target=event.target;if(!(target instanceof HTMLElement)||!target.matches('.pick-remove'))return;const form=target.closest('form.card'),input=form&&photoFor(form);if(!form||!input||typeof DataTransfer==='undefined')return;const index=Number(target.dataset.index);const transfer=new DataTransfer();[...input.files].forEach((file,position)=>{if(position!==index)transfer.items.add(file)});input.files=transfer.files;renderPicks(form)});
const updateCounts=(counts,savedProject)=>{if(!counts)return;const set=(selector,value)=>{const el=document.querySelector(selector);if(el)el.textContent=String(value)};const valueFor=(key)=>key==='all'?counts.all?.open:key===${JSON.stringify(project)}||key===savedProject?counts.project?.open:undefined;const tiles=document.querySelectorAll('[data-count-for]');for(const tile of tiles){const value=valueFor(tile.dataset.countFor);if(value!==undefined)tile.textContent=String(value)}const options=document.querySelectorAll('[data-open-for]');for(const opt of options){const value=valueFor(opt.dataset.openFor);if(value!==undefined)opt.textContent=value>0?opt.dataset.name+' ('+value+')':opt.dataset.name}const current=${JSON.stringify(project)}==='all'?counts.all:counts.project;set('[data-section="open"] .n',current?.open);set('[data-section="feedback"] .n',current?.feedback);initial=current?.open??initial;setTitle(initial)};
document.addEventListener('submit',async(event)=>{
const form=event.target;
if(!(form instanceof HTMLFormElement)||!form.matches('form.card'))return;
event.preventDefault();
if(form.dataset.busy)return;
const filer=form.closest('.filer');
const buttons=[...form.querySelectorAll('button')];
const body=new FormData(form);
if(event.submitter&&event.submitter.name)body.set(event.submitter.name,event.submitter.value);
form.dataset.busy='1';buttons.forEach((b)=>{b.disabled=true});
try{
const response=await fetch(form.action,{method:'POST',body,headers:{accept:'application/json'}});
const reply=await response.json().catch(()=>null);
if(!response.ok||!reply||!reply.ok)throw new Error(reply&&reply.error||'Could not save ('+response.status+')');
updateCounts(reply.counts,reply.item&&reply.item.project);
if(filer){const project=form.querySelector('select');const picked=project&&project.value;form.reset();if(project)project.value=picked;filer.open=false;say('Sent to the agent')}
else{
const holder=document.createElement('template');holder.innerHTML=reply.html.trim();
const next=holder.content.firstElementChild;
next.classList.add('settle');form.replaceWith(next);
const summary=next.querySelector('summary');if(summary)summary.focus({preventScroll:true});
say(reply.item.verdict==='approved'?'Approved':reply.item.verdict==='needs-work'?'Needs work saved':'Saved')}
clearPicks(form);
}catch(error){say(error instanceof TypeError?'Could not reach lookover. It may have saved; reload before retrying.':error.message)}
finally{delete form.dataset.busy;buttons.forEach((b)=>{b.disabled=false})}
});`;

const PLUS = '<svg class="plus" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

/** Drawn, not a unicode glyph: the page has one icon vocabulary and this is in it. */
const LEAVES_PAGE = '<svg class="leaves" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 3.5h6v6M12.5 3.5 4 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** --ink-soft, kept here because a data-URI chevron cannot read a CSS variable. */
const INK_SOFT = { light: '#5c5c63', dark: '#98989f' };

function chevronUrl(color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.25 8 10.25 12 6.25"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

const CHEVRON = '<svg class="chev" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6.25 8 10.25 12 6.25" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** A drawn reload arrow, used as a mask so it takes the line's own ink. */
const RELOAD_MASK = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8a5 5 0 1 1-1.46-3.54"/><path d="M13 2.5v3h-3"/></svg>')}")`;

const STYLE = `
*,*::before,*::after{box-sizing:border-box}
:root{color-scheme:light dark;accent-color:var(--accent);--accent:var(--page-accent);--accent-ink:var(--page-ink);
--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,monospace;
--ease:cubic-bezier(.23,1,.32,1);
--ground:#f2f2f7;--cell:#fff;--raised:#fff;--ink:#000;--ink-soft:${INK_SOFT.light};--sep:#d8d8dd;
--fill:#e9e9eb;--press:#dcdce0;--lift:0 1px 2px rgba(0,0,0,.06),0 3px 8px rgba(0,0,0,.1)}
@media(prefers-color-scheme:dark){:root{
--ground:#000;--cell:#1c1c1e;--raised:#636366;--ink:#fff;--ink-soft:${INK_SOFT.dark};--sep:#38383a;
--fill:#2c2c2e;--press:#3a3a3c;--lift:0 3px 8px rgba(0,0,0,.4)}}
html{background:var(--ground)}
body{margin:0;padding:1rem 1rem 5rem;background:var(--ground);color:var(--ink);
font:17px/1.4 var(--sans);-webkit-text-size-adjust:100%;text-size-adjust:100%;-webkit-tap-highlight-color:transparent}
main{max-width:44rem;margin:0 auto}
::selection{background:var(--accent);color:var(--accent-ink)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
a{color:inherit}
.brand{display:flex;align-items:center;gap:.4rem;margin:0 0 .35rem;font-size:13px;font-weight:600;color:var(--ink-soft)}
.mark{display:block;flex:none}
h1{margin:0;font-size:34px;line-height:1.12;font-weight:700;letter-spacing:.005em;overflow-wrap:anywhere}
.sub{margin:.2rem 0 0;font-size:15px;color:var(--ink-soft);overflow-wrap:anywhere}
.picker{padding:1.1rem 0 0}
/* A segmented control. Each project's hue is a dot beside its name, so the
   hue says which project and never says which one is selected. */
.tiles{display:flex;gap:2px;padding:2px;border-radius:10px;background:var(--fill)}
.tile{flex:1 1 0;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
min-height:44px;padding:.3rem .15rem;border-radius:8px;color:var(--ink);text-decoration:none;font-size:13px;line-height:1.2}
/* Up to five segments share the row, so a long name takes a second line
   rather than an ellipsis that hides which project it is. */
.tile .t{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;width:100%;overflow:hidden;
font-weight:500;text-align:center;overflow-wrap:break-word;hyphens:auto}
.tile .t::before{content:"";display:block;width:7px;height:7px;margin:0 auto 2px;border-radius:50%;background:var(--bl)}
.tiles:has(.tile:nth-child(5)) .tile{font-size:12px}
.tile.all .t::before{display:none}
.tile .n{font-size:12px;font-variant-numeric:tabular-nums;color:var(--ink-soft)}
.tile.selected{background:var(--raised);box-shadow:var(--lift)}
.tile.selected .t{font-weight:600}
.tile.selected .n{color:var(--ink)}
.tile:not(.selected):active{background:var(--press)}
.jump{display:flex;align-items:center;gap:.5rem;min-height:44px;margin:.75rem 0 0;padding:0 .4rem 0 1rem;
border-radius:12px;background:var(--cell)}
.jump label[for]{flex:none;margin:0;font-size:17px;font-weight:400;color:var(--ink)}
.jump select{flex:1;min-width:0;width:auto;min-height:44px;margin:0;padding:0 1.7rem 0 .5rem;border:0;
background-color:transparent;background-position:right .45rem center;color:var(--ink-soft);font-size:15px;
text-align:right;text-align-last:right}
/* Go is only for pages without JavaScript; the script hides it. */
.jump .go{flex:none;width:auto;min-width:0;min-height:44px;margin:0;padding:0 .9rem;font-size:15px;
color:var(--ink);background:var(--fill)}
/* button{display:block} outranks the UA sheet's [hidden], so the script's
   g.hidden=true left the button on screen. */
.jump .go[hidden]{display:none}
.new-count{margin:.75rem 0 0;border-radius:12px;background:var(--accent);color:var(--accent-ink);
font-weight:600;font-size:15px}
.new-count a{display:flex;align-items:center;gap:.55rem;min-height:44px;padding:0 1rem;color:inherit;text-decoration:none}
.new-count a::before{content:"";flex:none;width:16px;height:16px;background:currentColor;
-webkit-mask:${RELOAD_MASK} center/contain no-repeat;mask:${RELOAD_MASK} center/contain no-repeat}
.new-count[hidden]{display:none}
.fold>summary{display:flex;align-items:center;gap:.5rem;min-height:44px;padding:0 1rem;list-style:none;cursor:pointer;
font-size:17px;color:var(--ink)}
.fold>summary::-webkit-details-marker{display:none}
.fold>summary:active{background:var(--press)}
.chev{margin-left:auto;flex:none;color:var(--ink-soft);transform:rotate(-90deg)}
.fold[open]>summary .chev{transform:none}
.filer,.history{margin:.75rem 0 0;border-radius:12px;background:var(--cell);overflow:hidden}
.history{margin:0}
.filer>.card{margin:0;padding:0 1rem 1rem;border-radius:0;box-shadow:inset 0 1px 0 var(--sep)}
/* Sentence case, not tracked-out caps, so every pinned section string renders
   as the pad writes it. Do not quote those strings here: a page test slices
   the HTML on them and a copy in the stylesheet becomes a false delimiter. */
h2{display:flex;align-items:baseline;gap:.5rem;margin:2.1rem 0 .6rem;font-size:22px;line-height:1.2;font-weight:700;letter-spacing:.005em}
h2 .n{margin-left:auto;font-size:17px;font-weight:400;font-variant-numeric:tabular-nums;color:var(--ink-soft)}
.card{--accent:var(--bl,var(--page-accent));--accent-ink:var(--bil,var(--page-ink));
margin:0 0 .75rem;padding:.95rem 0 0;background:var(--cell);border-radius:12px;overflow:hidden;scroll-margin-top:1rem}
h3{margin:0 1rem;font-size:20px;line-height:1.25;font-weight:600;letter-spacing:.005em;overflow-wrap:anywhere;text-wrap:balance}
.tags{display:flex;flex-wrap:wrap;align-items:center;gap:.35rem;margin:0 1rem .4rem}
.project-badge,.badge,.prio{display:inline-flex;align-items:center;padding:.14rem .5rem;border-radius:6px;
font-size:12px;font-weight:600;line-height:1.35;white-space:nowrap}
.prio{background:var(--fill);color:var(--ink)}
.prio.first{background:var(--ink);color:var(--cell)}
.project-badge{background:var(--accent);color:var(--accent-ink)}
.badge{background:var(--fill);color:var(--ink-soft)}
.badge.approved{color:var(--ink)}
.badge.needs-work{background:var(--ink);color:var(--cell)}
.source{margin:.3rem 1rem 0;font-size:13px;color:var(--ink-soft);overflow-wrap:anywhere}
.source .id{font-variant-numeric:tabular-nums}
.retest{margin:.45rem 1rem 0;font-size:13px;color:var(--ink-soft)}
.retest a{display:inline-flex;align-items:center;min-height:44px;padding:0 .3rem;margin:-.8rem -.3rem;color:var(--ink);text-underline-offset:2px}
.open{display:flex;align-items:center;gap:.6rem;min-height:44px;margin:.9rem 0 0;padding:.6rem 1rem;
box-shadow:inset 0 1px 0 var(--sep);color:var(--ink);font-size:15px;line-height:1.35;text-decoration:none;overflow-wrap:anywhere}
.open .leaves{flex:none;margin-left:auto;color:var(--ink-soft)}
.open:active{background:var(--press)}
.details{margin:.9rem 0 0;padding:.85rem 1rem 0;box-shadow:inset 0 1px 0 var(--sep);font-size:16px;line-height:1.5}
.open+.details,.open+.retest+.details{margin-top:0}
.details:empty{display:none}
.details>:first-child{margin-top:0}
.details>:last-child{margin-bottom:0}
.details p{margin:0 0 .6rem}
.details ul,.details ol{margin:0 0 .6rem;padding-left:1.35rem}
.details li{margin:.25rem 0}
.details a{color:var(--ink);text-underline-offset:2px;overflow-wrap:anywhere}
.details code{padding:.05em .3em;background:var(--fill);border-radius:5px;font-family:var(--mono);font-size:.86em}
.details pre{margin:0 0 .6rem;padding:.7rem .8rem;background:var(--fill);border-radius:10px;overflow-x:auto;scrollbar-width:thin}
.details pre code{padding:0;background:none}
/* What you said, shaped as a sent message: it is your side of the exchange. */
.quote{margin:.9rem 1rem 0;padding:.55rem .8rem;background:var(--fill);border-radius:14px 14px 14px 4px;
font-size:16px;white-space:pre-wrap;overflow-wrap:anywhere}
/* One row that scrolls sideways inside the card, never the page. */
.shots{display:flex;gap:.5rem;margin:.9rem 0 0;padding:0 1rem;overflow-x:auto;scroll-snap-type:x mandatory;
scroll-padding:0 1rem;scrollbar-width:none}
.shots::-webkit-scrollbar{display:none}
.shots::after{content:"";flex:0 0 .5rem}
.shots a{flex:none;display:block;scroll-snap-align:start;border-radius:10px;overflow:hidden;line-height:0;
box-shadow:inset 0 0 0 1px var(--sep)}
.shots img{display:block;height:9rem;width:auto;max-width:none;background:var(--fill)}
.reply{margin:1rem 0 0;padding:1rem;box-shadow:inset 0 1px 0 var(--sep)}
.answer{margin:1rem 0 0;box-shadow:inset 0 1px 0 var(--sep)}
.answer>.reply{margin:0;padding-top:.25rem;box-shadow:none}
.verdict-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.5rem;margin:.5rem 0 0}
label[for]{display:block;margin:1rem 0 0;font-size:13px;color:var(--ink-soft)}
label.photo{display:inline-flex;align-items:center;gap:.4rem;min-height:44px;margin:.3rem .6rem 0 0;padding:0;
font-size:15px;color:var(--ink);vertical-align:middle;cursor:pointer}
label.photo:active{opacity:.6}
.photo .plus{flex:none}
textarea,input[name=title],select{display:block;width:100%;margin:.4rem 0 0;padding:.65rem .8rem;
font:inherit;color:var(--ink);background:var(--fill);border:0;border-radius:10px;caret-color:var(--accent)}
.reply>textarea{margin:0}
/* The one control the browser draws for itself, given this page's chevron. */
select{appearance:none;-webkit-appearance:none;padding-right:2.3rem;font-size:15px;
background-image:${chevronUrl(INK_SOFT.light)};background-repeat:no-repeat;
background-position:right .8rem center;background-size:15px 15px}
textarea{min-height:5.5rem;resize:vertical}
input[name=title],select{min-height:44px}
::placeholder{color:var(--ink-soft);opacity:1}
/* A file input's intrinsic width is ~240px whatever it holds, which pushed
   its own status text onto a second line under the button. */
.photo-input{display:inline-block;width:11rem;max-width:100%;margin:0;font:inherit;font-size:13px;
color:var(--ink-soft);vertical-align:middle}
.photo-input::file-selector-button{display:none}
.picks{display:flex;gap:.5rem;margin:.5rem 0 0;overflow-x:auto;scrollbar-width:none}
.picks[hidden]{display:none}
.picks::-webkit-scrollbar{display:none}
.pick{position:relative;flex:none;width:5rem;min-height:5rem;padding-bottom:1.35rem;overflow:hidden;border-radius:9px;background:var(--fill);font-size:11px;color:var(--ink-soft)}
.pick img{display:block;width:5rem;height:4rem;object-fit:cover}
.pick span{display:block;padding:.1rem .3rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pick-remove{position:absolute;right:0;bottom:0;width:auto;min-width:0;min-height:1.25rem;margin:0;padding:0 .3rem;border-radius:0;font-size:11px;font-weight:500;color:var(--ink);background:var(--fill)}
button{display:block;width:100%;min-height:50px;margin:1rem 0 0;padding:0 1.2rem;font:inherit;font-size:17px;
font-weight:600;color:var(--accent-ink);background:var(--accent);border:0;border-radius:12px;cursor:pointer}
@media(min-width:34rem){button{width:auto;min-width:11rem}}
button.verdict{width:auto;min-width:0;margin:0;padding:0 .5rem;font-size:16px;color:var(--ink);background:var(--fill);white-space:nowrap}
button.verdict.approved{color:var(--accent-ink);background:var(--accent)}
/* The answer already saved, ringed in ink: a state, where the accent is an identity. */
button.verdict.selected{box-shadow:0 0 0 2px var(--cell),0 0 0 4px var(--ink)}
.empty{display:flex;flex-direction:column;align-items:center;gap:.75rem;margin:0;padding:1.9rem 1rem;
background:var(--cell);border-radius:12px;color:var(--ink-soft);font-size:15px;text-align:center}
.done-mark{display:block}
/* A section with nothing in it is a line, not a panel. Only the pinned
   "Nothing to test" line earns a panel: it is the one that is good news. */
.none{margin:0;padding:.1rem 0;color:var(--ink-soft);font-size:15px}
.empty code{font-family:var(--mono);font-size:.88em}
.toast{position:fixed;left:50%;bottom:calc(4.5rem + env(safe-area-inset-bottom));z-index:10;transform:translateX(-50%);
max-width:min(26rem,calc(100vw - 2rem));padding:.7rem 1.1rem;border-radius:12px;background:var(--ink);color:var(--cell);
font-size:15px;font-weight:600;line-height:1.3;text-align:center;opacity:0;pointer-events:none}
.toast.show{opacity:1}
.done{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:baseline;gap:.2rem .75rem;padding:.7rem 1rem;
box-shadow:inset 1rem 1px 0 var(--cell),inset 0 1px 0 var(--sep)}
.done strong{font-size:16px;font-weight:400;overflow-wrap:anywhere}
.done .meta{grid-column:1/-1;font-size:13px;color:var(--ink-soft);overflow-wrap:anywhere}
@media(prefers-reduced-motion:no-preference){
button,.shots a{transition:transform 120ms var(--ease)}
button:active,.shots a:active{transform:scale(.97)}
.chev{transition:transform 150ms var(--ease)}
.fold[open]>summary~*{animation:open 150ms var(--ease)}
.new-count:not([hidden]){animation:drop 180ms var(--ease)}
.toast{transform:translate(-50%,8px);transition:opacity 180ms var(--ease),transform 180ms var(--ease)}
.toast.show{transform:translate(-50%,0)}
/* With no script a save redirects onto the card in its new section; it settles in. */
.card:target{animation:settle 180ms var(--ease)}
.card.settle{animation:settle 180ms var(--ease)}}
@keyframes open{from{opacity:0;transform:translateY(-4px)}}
@keyframes drop{from{opacity:0;transform:translateY(-6px)}}
@keyframes settle{from{opacity:.5;transform:translateY(8px) scale(.99)}}
@media(prefers-color-scheme:dark){
select{background-image:${chevronUrl(INK_SOFT.dark)}}
.tile .t::before{background:var(--bd)}
.card{--accent:var(--bd,var(--page-accent));--accent-ink:var(--bid,var(--page-ink))}}
`;

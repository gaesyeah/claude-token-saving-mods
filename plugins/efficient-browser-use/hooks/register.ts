import type { EngineInterface, Register } from 'claude-code'
import { addShots, closePane, loadTotals, openPane, registerPane, resetPane, restoreShots, setBusy, setOff, setSwitchHidden, setThumb, setTotals } from './pane.tsx'
import type { ShotCard } from '../types'

// Efficient Browser Use: during a browser task Claude takes a screenshot after almost every click, and
// each one costs about width x height / 750 tokens. This mod shrinks each screenshot with ImageMagick
// (or libvips, ffmpeg, Pillow, macOS `sips`, whichever is installed)
// before Claude reads it, or in describe mode has a Haiku subagent write it out in words instead.
// It owns every tool result with an image block (TOKEN-MODS-SPEC section 6): browser pane and Chrome
// screenshots, Read on a picture, any connector that returns one. It was called Image Offload.

const NAME = 'efficient-browser-use'
const LABEL = 'Efficient Browser Use'

type Mode = 'shrink' | 'describe'
type Settings = { mode: Mode; scale: number; min: number }

// Half of each side is a quarter of the tokens. Never below 512 px on the long side.
const DEFAULTS: Settings = { mode: 'shrink', scale: 0.5, min: 512 }
// The API scales a picture down to 1568 px on its long side before the model sees it,
// so a bigger one never costs more than that.
const API_LONG = 1568

// Module variables reset on a reload; the settings live in $.store.
let home = ''
// ---- Config folder ----
// Where Claude Code keeps its files: CLAUDE_CONFIG_DIR when it is set, else <home>/.claude.
// Read from the environment when a chat starts. The plugin's own path is only the last
// resort: a pack installed from a local folder (say ~/Downloads) does not sit under ~/.claude.
let claudeDir = ''
// Set by $.mods.paths() when the chat starts.
const claudeDirOf = (_: EngineInterface) => claudeDir
let session = ''
let off = false
let settings: Settings = { ...DEFAULTS }
// /efficient-browser full: how many tool results may still pass at full size.
let fullPasses = 0
let seq = 0
let describerReady = false
const totals = { seen: 0, images: 0, before: 0, after: 0, pasted: 0 }
// "efficient-browser-use:hidden" in switches.json: the pane never opens by itself.
let hidden = false
let switchError = ''

const logPath = () => `${claudeDir}/mods-logs/${NAME}.log`
const ledgerPath = () => `${claudeDir}/mods-logs/savings.jsonl`
const tmpDir = () => `${claudeDir}/mods-logs/${NAME}/tmp`

// The /mods switchboard: "efficient-browser-use": false turns the mod off in every chat, and
// "efficient-browser-use:hidden": true keeps the pane shut until it is asked for. Read only.
async function readSwitch($: EngineInterface) {
  let now = off
  let nowHidden = hidden
  try {
    const json = await $.mods.readSwitches()
    now = json[NAME] === false
    nowHidden = json[`${NAME}:hidden`] === true
    switchError = ''
  } catch (err) {
    // A broken file changes nothing. Logged once, not every 3 seconds.
    const said = err instanceof Error ? err.message : String(err)
    if (said !== switchError) void log($, `switches.json not read, nothing changed: ${said}`)
    switchError = said
  }
  if (nowHidden !== hidden) {
    hidden = nowHidden
    setSwitchHidden(hidden)
    if (hidden) await closePane($)
  }
  if (now === off) return
  off = now
  if (off) fullPasses = 0
  await setOff($, off).catch(() => undefined)
  if (off) await closePane($)
  try {
    $.ui.status(off ? undefined : statusLine())
  } catch {
    // The next shrink sets it again.
  }
}

// Open in /mods writes an empty file named for this mod and this chat: open the pane, remove the file.
async function checkOpen($: EngineInterface) {
  if (!session || !home) return
  if (!(await $.mods.openAsked({ mod: NAME }))) return
  if (!off) await showPane($)
}

/** The person asked for the pane: open it with every card from this chat, the ledger's too. */
async function showPane($: EngineInterface): Promise<number> {
  await openPane($, true)
  const added = await restoreShots($, await ledgerCards($)).catch(err => {
    void log($, `pane restore: ${String(err)}`)
    return 0
  })
  if (added > 0) void log($, `pane: ${added} card(s) the pane had lost were added back from the ledger`)
  return added
}

// $.fs has no append, and a read-then-write can drop another mod's line, so the shell appends.
// A true append through mods-core (which falls back to read and write where the shell fails).
async function append($: EngineInterface, path: string, line: string) {
  await $.mods.append({ path, text: line.endsWith('\n') ? line : `${line}\n` })
}

// One line through mods-core: stamped with the time, its file kept under 2 MB.
async function log($: EngineInterface, line: string) {
  await $.mods.log({ file: logPath(), line }).catch(() => undefined)
}

// TOKEN-MODS-SPEC section 4: image estimate is width x height / 750.
export function imageTokens(w: number, h: number): number {
  const long = Math.max(w, h)
  const f = long > API_LONG ? API_LONG / long : 1
  return Math.ceil((Math.round(w * f) * Math.round(h * f)) / 750)
}

const fmt = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

function statusLine() {
  if (totals.images === 0) return undefined
  return `${LABEL}: ${totals.images} picture${totals.images === 1 ? '' : 's'}, ~${fmt(totals.before - totals.after)} tokens saved`
}

// ---- finding pictures in a result ----

type Obj = Record<string, unknown>
type Hit = { block: Obj; label?: Obj }

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

function isImage(v: unknown): v is Obj {
  if (!isObj(v) || v.type !== 'image') return false
  // MCP block { data, mimeType }, API block { source: { data } }, Read's { file: { base64 } }.
  return typeof v.data === 'string' || (isObj(v.source) && typeof v.source.data === 'string') || (isObj(v.file) && typeof v.file.base64 === 'string')
}

const isText = (v: unknown): v is Obj => isObj(v) && v.type === 'text' && typeof v.text === 'string'

export function findImages(node: unknown, hits: Hit[] = []): Hit[] {
  if (Array.isArray(node)) {
    node.forEach((item, i) => {
      if (isImage(item)) {
        const prev = node[i - 1]
        hits.push({ block: item, label: isText(prev) ? prev : undefined })
      } else findImages(item, hits)
    })
  } else if (isObj(node)) {
    if (isImage(node)) hits.push({ block: node })
    else for (const v of Object.values(node)) findImages(v, hits)
  }
  return hits
}

function bytesOf(b: Obj): { base64: string; mime: string } {
  if (typeof b.data === 'string') return { base64: b.data, mime: String(b.mimeType ?? '') }
  if (isObj(b.source)) return { base64: String(b.source.data), mime: String(b.source.media_type ?? '') }
  const file = b.file as Obj
  return { base64: String(file.base64), mime: String(file.type ?? '') }
}

function sniff(base64: string, mime: string): string {
  if (base64.startsWith('iVBOR')) return 'image/png'
  if (base64.startsWith('/9j/')) return 'image/jpeg'
  if (base64.startsWith('R0lGOD')) return 'image/gif'
  if (base64.startsWith('UklGR')) return 'image/webp'
  return mime || 'image/png'
}

function setBytes(b: Obj, base64: string, mime: string, w: number, h: number, nw: number, nh: number) {
  if (typeof b.data === 'string') {
    b.data = base64
    b.mimeType = mime
  } else if (isObj(b.source)) {
    b.source = { ...b.source, data: base64, media_type: mime }
  } else {
    const file = b.file as Obj
    const dims = isObj(file.dimensions) ? file.dimensions : {}
    // The original size stays the real one, so a click mapped from the picture lands right.
    b.file = {
      ...file,
      base64,
      type: mime,
      dimensions: { ...dims, originalWidth: dims.originalWidth ?? w, originalHeight: dims.originalHeight ?? h, displayWidth: nw, displayHeight: nh },
    }
  }
}

// The browser pane's own line, after the picture: `Screenshot size: 800x600` when unscaled,
// `Screenshot size: 240x180 0.3-scale view; coordinate frame: 800x600.` when scaled.
// Its coordinate frame must never change: clicks use it.
const SIZE = /Screenshot size: (\d+)x(\d+)(?: [\d.]+-scale view)?(?:; coordinate frame: (\d+)x(\d+))?/g

export function findTexts(node: unknown, out: Obj[] = []): Obj[] {
  if (Array.isArray(node)) for (const v of node) findTexts(v, out)
  else if (isText(node)) out.push(node)
  else if (isObj(node)) for (const v of Object.values(node)) findTexts(v, out)
  return out
}

// Rewrites the first line that names this picture's size into the tool's own scaled form.
export function relabel(texts: Obj[], w: number, h: number, nw: number, nh: number): boolean {
  for (const t of texts) {
    const text = String(t.text)
    for (const m of text.matchAll(SIZE)) {
      if (Number(m[1]) !== w || Number(m[2]) !== h || m.index === undefined) continue
      const fw = m[3] ? Number(m[3]) : w
      const fh = m[4] ? Number(m[4]) : h
      const scale = Number((nw / fw).toFixed(2))
      t.text = `${text.slice(0, m.index)}Screenshot size: ${nw}x${nh} ${scale}-scale view; coordinate frame: ${fw}x${fh}${text.slice(m.index + m[0].length)}`
      return true
    }
  }
  return false
}

// A short picture of the result's shape for the log, never the bytes.
function shape(node: unknown, depth = 0): string {
  if (depth > 3) return '…'
  if (Array.isArray(node)) return `[${node.slice(0, 8).map(v => (isObj(v) && typeof v.type === 'string' ? v.type : shape(v, depth + 1))).join(',')}${node.length > 8 ? ',…' : ''}]`
  if (isObj(node)) return `{${Object.keys(node).slice(0, 10).map(k => `${k}:${typeof node[k] === 'string' ? 's' : shape(node[k], depth + 1)}`).join(',')}}`
  return typeof node === 'string' ? 's' : String(typeof node)
}

// ---- shrinking ----

// Reads a picture's pixel size from its first bytes (PNG, JPEG, GIF, WebP), so no tool is needed for it.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function headBytes(base64: string, max = 262_144): Uint8Array {
  const s = base64.slice(0, Math.ceil(max / 3) * 4).replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((s.length * 3) / 4))
  let n = 0
  for (let i = 0; i + 1 < s.length; i += 4) {
    const a = B64.indexOf(s[i]!), b = B64.indexOf(s[i + 1]!)
    const c = i + 2 < s.length ? B64.indexOf(s[i + 2]!) : -1
    const d = i + 3 < s.length ? B64.indexOf(s[i + 3]!) : -1
    out[n++] = (a << 2) | (b >> 4)
    if (c >= 0) out[n++] = ((b & 15) << 4) | (c >> 2)
    if (d >= 0) out[n++] = ((c & 3) << 6) | d
  }
  return out.subarray(0, n)
}
function imageSize(base64: string): { w: number; h: number } | null {
  const b = headBytes(base64)
  const u16 = (i: number) => (b[i]! << 8) | b[i + 1]!
  const u32 = (i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!
  const le16 = (i: number) => b[i]! | (b[i + 1]! << 8)
  const le24 = (i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return { w: u32(16), h: u32(20) }
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49) return { w: le16(6), h: le16(8) }
  if (b.length > 30 && b[0] === 0x52 && b[8] === 0x57) {
    const tag = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!)
    if (tag === 'VP8 ') return { w: le16(26) & 0x3fff, h: le16(28) & 0x3fff }
    if (tag === 'VP8L') {
      const v = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)
      return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }
    }
    if (tag === 'VP8X') return { w: le24(24) + 1, h: le24(27) + 1 }
    return null
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue }
      const m = b[i + 1]!
      if (m === 0xff) { i++; continue }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: u16(i + 7), h: u16(i + 5) }
      i += 2 + u16(i + 2)
    }
  }
  return null
}

// Resizes "$1" to exactly "$3"x"$4" pixels into "$2" with the first image tool found:
// ImageMagick 7 or 6, libvips, ffmpeg, Python Pillow, or macOS sips. "$5" is a JPEG quality.
// Reads base64 on stdin and prints the new picture as base64. Exit 3: no tool on this computer.
const RESIZE = `set -e
in="$1"; out="$2"; w="$3"; h="$4"; q="$5"; keep="$6"
mkdir -p "$(dirname "$in")"
base64 -d > "$in"
has() { command -v "$1" >/dev/null 2>&1; }
if has magick; then magick "$in[0]" -resize "\${w}x\${h}!" \${q:+-quality "$q"} "$out"
elif has convert && convert -version 2>/dev/null | grep -q ImageMagick; then convert "$in[0]" -resize "\${w}x\${h}!" \${q:+-quality "$q"} "$out"
elif has vipsthumbnail; then vipsthumbnail "$in" -s "\${w}x\${h}!" -o "$out\${q:+[Q=$q]}"
elif has ffmpeg; then ffmpeg -loglevel error -y -i "$in" -frames:v 1 -vf "scale=$w:$h:flags=lanczos" \${q:+-q:v 4} "$out"
elif has python3 && python3 -c 'import PIL' 2>/dev/null; then
  python3 -c 'import sys; from PIL import Image
im = Image.open(sys.argv[1]); im.seek(0); im = im.convert("RGB") if sys.argv[2].endswith(".jpg") else im.convert("RGBA")
im.resize((int(sys.argv[3]), int(sys.argv[4])), Image.LANCZOS).save(sys.argv[2], quality=int(sys.argv[5] or 85))' "$in" "$out" "$w" "$h" "$q"
elif has sips; then
  case "$out" in *.jpg) sips -z "$h" "$w" -s format jpeg \${q:+-s formatOptions "$q"} "$in" --out "$out" >/dev/null ;;
  *) sips -z "$h" "$w" -s format png "$in" --out "$out" >/dev/null ;; esac
else
  if [ "$keep" != 1 ]; then rm -f "$in"; fi
  echo "no image tool: install ImageMagick (or libvips, ffmpeg, python3-pil)" >&2; exit 3
fi
base64 < "$out" | tr -d '\\n'
rm -f "$out"
if [ "$keep" != 1 ]; then rm -f "$in"; fi`

type Shrunk = { w: number; h: number; nw?: number; nh?: number; base64?: string; mime: string; file: string }

// Fits w x h inside a long side of `long`, keeping the shape.
function fit(w: number, h: number, long: number) {
  const k = long / Math.max(w, h)
  return { nw: Math.max(1, Math.round(w * k)), nh: Math.max(1, Math.round(h * k)) }
}

async function shrink($: EngineInterface, base64: string, mime: string, keep: boolean): Promise<Shrunk> {
  seq += 1
  const kind = sniff(base64, mime)
  // PNG and JPEG are written back as they came; GIF and WebP become PNG.
  const ext = kind === 'image/jpeg' ? 'jpg' : 'png'
  const stem = `${tmpDir()}/${Date.now()}-${seq}`
  const file = `${stem}-in.${kind === 'image/jpeg' ? 'jpg' : kind.split('/')[1] ?? 'png'}`
  const size = imageSize(base64)
  if (!size || !size.w || !size.h) throw new Error(`no size read from the ${kind} header`)
  const { w, h } = size
  const long = Math.max(w, h)
  const target = Math.max(Math.round(long * settings.scale), settings.min)
  if (target >= long) {
    // Kept for a describe hand-off: the picture is written as it came.
    if (keep) {
      const r = await $.process.run(['/bin/sh', '-c', 'mkdir -p "$(dirname "$1")" && base64 -d > "$1"', 'sh', file], { stdin: base64, timeoutMs: 20_000 })
      if (r.exitCode !== 0) throw new Error(`write exit ${r.exitCode}: ${r.stderr.slice(0, 200)}`)
    }
    return { w, h, mime: kind, file }
  }
  const { nw, nh } = fit(w, h, target)
  const r = await $.process.run(
    ['/bin/sh', '-c', RESIZE, 'sh', file, `${stem}-out.${ext}`, String(nw), String(nh), ext === 'jpg' ? '85' : '', keep ? '1' : '0'],
    { stdin: base64, timeoutMs: 20_000 },
  )
  if (r.exitCode !== 0) throw new Error(`resize exit ${r.exitCode}: ${r.stderr.slice(0, 200)}`)
  const out = r.stdout.replace(/\s+/g, '')
  const got = imageSize(out)
  if (!out || !got) throw new Error(`no picture back from the resize: ${r.stdout.slice(0, 80)}`)
  return { w, h, nw: got.w, nh: got.h, base64: out, mime: ext === 'jpg' ? 'image/jpeg' : 'image/png', file }
}

// ---- the pane's small picture ----

// A 160 px JPEG of the picture Claude got, for the newest cards in the pane.
async function thumbnail($: EngineInterface, cardId: string, base64: string) {
  const size = imageSize(base64)
  if (!size || !size.w || !size.h) return
  const { nw, nh } = Math.max(size.w, size.h) > 160 ? fit(size.w, size.h, 160) : { nw: size.w, nh: size.h }
  const stem = `${tmpDir()}/thumb-${Date.now()}-${cardId}`
  const r = await $.process.run(['/bin/sh', '-c', RESIZE, 'sh', `${stem}-in`, `${stem}.jpg`, String(nw), String(nh), '60', '0'], { stdin: base64, timeoutMs: 10_000 })
  const out = r.stdout.replace(/\s+/g, '')
  // Over this size it is no thumbnail: the pane goes without.
  if (r.exitCode === 0 && out && out.length < 60_000) await setThumb($, cardId, out)
}

// ---- describing (opt-in) ----

const DESCRIBER_PROMPT = `You describe one picture for another AI assistant that cannot see it.
Read the picture file you are given with the Read tool. Then answer with plain text only, at most 250 words, no preamble:
- what it is (a web page, an app window, a chart, a photo, ...)
- every piece of readable text, word for word, in reading order
- buttons, fields, links and menus, with their rough place (top left, centre, ...)
- the state it shows: errors, dialogs, selected or empty items, loading.`

async function registerDescriber($: EngineInterface) {
  if (describerReady) return
  try {
    await $.agent.register({
      name: 'describer',
      description: 'Efficient Browser Use only: describes one picture file in words. Not for general use.',
      prompt: DESCRIBER_PROMPT,
      tools: ['Read'],
      model: 'haiku',
    })
    describerReady = true
  } catch (err) {
    void log($, `describer not registered, general-purpose on haiku instead: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function describe($: EngineInterface, file: string): Promise<{ text: string; tokens: number | null }> {
  const r = await $.tool.call({
    tool: 'Agent',
    description: 'Describe a picture',
    prompt: describerReady ? `Describe the picture at ${file}` : `${DESCRIBER_PROMPT}\n\nThe picture: ${file}`,
    subagent_type: describerReady ? `${NAME}:describer` : 'general-purpose',
    model: 'haiku',
  } as never)
  const raw = 'text' in r && typeof r.text === 'string' ? r.text : ''
  if (r.deny !== undefined || r.isError || !raw.trim()) throw new Error(r.deny ?? (raw.slice(0, 200) || 'no description'))
  const used = /total_tokens:\s*(\d+)/.exec(raw)
  const text = raw
    .replace(/<usage>[\s\S]*?<\/usage>/g, '')
    .replace(/^agentId:.*$/gm, '')
    .trim()
  return { text, tokens: used ? Number(used[1]) : null }
}

// ---- the ledger ----

type Line = { tool_use_id: string | null; action: string; before: number; after: number; helper: Obj | null; detail?: string }

async function ledger($: EngineInterface, line: Line) {
  const ts = new Date(await $.clock.now()).toISOString().replace(/\.\d+Z$/, 'Z')
  const row = { ts, session, tool_use_id: line.tool_use_id, mod: NAME, action: line.action, before: line.before, after: line.after, helper: line.helper, measured: 'estimated', ...(line.detail ? { detail: line.detail } : {}) }
  await $.mods.ledger({ row })
}

// ---- pictures Claude sized itself ----

function sizedBy(a: Obj): string | null {
  if (a.action === 'zoom') return 'a zoom, Claude picked its size'
  if (typeof a.scale === 'number') return `Claude set scale ${a.scale}`
  return null
}

/**
 * For each picture, why it stays as it is, or null to shrink it. A zoom, or a screenshot Claude
 * gave its own scale, stays as Claude asked. In a batch the scale sits on each action, so the
 * pictures are matched to the screenshot and zoom actions in order. When the counts differ, each
 * picture's own label line says it: "[computer:zoom]", or "0.6-scale view" for a scale.
 */
export function ownSizes(input: Obj, labels: string[], text: string, min: number, warn: (said: string) => void): Array<string | null> {
  const n = labels.length
  let why: Array<string | null>
  if (!Array.isArray(input.actions)) why = labels.map(() => sizedBy(input))
  else {
    const shots = input.actions
      .map(a => (isObj(a) && isObj(a.input) ? a.input : {}))
      .filter(a => a.action === 'screenshot' || a.action === 'zoom')
    if (shots.length === n) why = shots.map(sizedBy)
    else {
      warn(`batch with ${n} picture(s) and ${shots.length} screenshot or zoom action(s): matched by label instead`)
      why = labels.map(l => (/:zoom\]/.test(l) ? 'a zoom, Claude picked its size' : /[\d.]+-scale view/.test(l) ? 'Claude set its own scale' : null))
    }
  }
  // A picture Claude sized that is no bigger than the floor: say so, it is the main reason.
  return why.map((w, i) => {
    if (!w) return w
    const m = /Screenshot size: (\d+)x(\d+)/.exec(labels[i] || text)
    return m && Math.max(Number(m[1]), Number(m[2])) <= min ? `already small (${w})` : w
  })
}

// ---- the ledger, read back ----

const SHRANK = /^shrank (\S+) picture (\d+)x(\d+) to (\d+)x(\d+)$/
const DESCRIBED = /^described (\S+) picture (\d+)x(\d+) in words$/

/** This chat's shrunk and described pictures, as the ledger has them. */
async function ledgerCards($: EngineInterface): Promise<Array<Omit<ShotCard, 'id'>>> {
  if (!session) return []
  const r = await $.process.run(['/usr/bin/grep', '-F', `"session":"${session}"`, ledgerPath()])
  const out: Array<Omit<ShotCard, 'id'>> = []
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue
    let row: Obj
    try {
      row = JSON.parse(line) as Obj
    } catch {
      continue
    }
    if (row.mod !== NAME) continue
    const at = Date.parse(String(row.ts)) || 0
    const base = {
      at,
      before: Number(row.before) || 0,
      after: Number(row.after) || 0,
      note: 'Rebuilt from the ledger (savings.jsonl). The note Claude got was not kept.',
      ...(typeof row.tool_use_id === 'string' ? { toolUseId: row.tool_use_id } : {}),
    }
    const a = String(row.action)
    const s = SHRANK.exec(a)
    const d = DESCRIBED.exec(a)
    if (s) out.push({ ...base, tool: s[1]!, action: 'shrank', w: Number(s[2]), h: Number(s[3]), nw: Number(s[4]), nh: Number(s[5]) })
    else if (d) out.push({ ...base, tool: d[1]!, action: 'described', w: Number(d[2]), h: Number(d[3]) })
  }
  return out
}

// ---- the hooks ----

export const register: Register = on => {
  resetPane()
  registerPane(on)

  on('session.start', async ($, e, next) => {
    ;({ home, claudeDir } = await $.mods.paths())
    // A reload starts the module over; the chat's totals live on in $.state.
    Object.assign(totals, await loadTotals($).catch(() => totals))
    await $.command.register({
      name: 'efficient-browser',
      description: 'Efficient Browser Use. pane: open the pane. full: let the next picture through at full size. shrink, describe, scale 0.5, min 512',
      argumentHint: '[pane|full|shrink|describe|scale <0.2-0.9>|min <px>]',
      immediate: true,
    })
    const stored = await $.store.get('settings').catch(() => undefined)
    if (isObj(stored)) {
      settings = {
        mode: stored.mode === 'describe' ? 'describe' : 'shrink',
        scale: typeof stored.scale === 'number' ? stored.scale : DEFAULTS.scale,
        min: typeof stored.min === 'number' ? stored.min : DEFAULTS.min,
      }
    }
    session = await $.session.id().catch(() => '')
    await readSwitch($).catch(() => undefined)
    $.clock.every(3000, () => {
      void readSwitch($)
        .then(() => checkOpen($))
        .catch(err => log($, `switch poll: ${String(err)}`))
    })
    if (settings.mode === 'describe' && !off) await registerDescriber($)
    return next(e)
  })

  // Pasted pictures: a mod sees that they exist, never their bytes, and cannot drop or swap them.
  on('prompt.submit', async ($, e, next) => {
    if (!off) {
      const pics = (e.attachments ?? []).filter(a => a.type === 'image').length
      if (pics > 0) {
        totals.pasted += pics
        void setTotals($, totals).catch(() => undefined)
        void log($, `prompt carries ${pics} pasted picture(s): left as they are (mods cannot read or change pasted pictures)`)
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (off) return next(e)
    const input = e as unknown as Obj
    // The describer's own Read of a temp picture goes through untouched.
    if (e.tool === 'Read' && e.agentId !== undefined && String(input.file_path ?? '').startsWith(tmpDir())) return next(e)
    const r = await next(e)
    if (off || r.deny !== undefined || r.isError) return r
    const hits = findImages(r.result)
    // A screenshot call that comes back with no picture found: the shape says why.
    const watched = /screenshot|browser_batch/i.test(e.tool) || input.action === 'screenshot'
    if (watched || hits.length > 0) void log($, `${e.tool} result shape ${shape(r.result)}, ${hits.length} picture(s)`)
    if (hits.length === 0) return r

    const id = typeof e.tool_use_id === 'string' ? e.tool_use_id : null
    // Every card of this call is written once, at the end: see addShots.
    const cards: Array<Omit<ShotCard, 'id' | 'at'>> = []
    const alone = new Map<string, number>()
    const leave = (i: number, reason: string) => {
      alone.set(reason, (alone.get(reason) ?? 0) + 1)
      void log($, `${e.tool}: picture ${i + 1} of ${hits.length} left alone: ${reason}`)
    }
    totals.seen += hits.length

    // Which pictures Claude sized itself: a zoom, or a screenshot with its own scale.
    const own = ownSizes(
      input,
      hits.map(h => (h.label ? String(h.label.text) : '')),
      hits.length === 1 ? findTexts(r.result).map(t => String(t.text)).join('\n') : '',
      settings.min,
      said => void log($, `${e.tool}: ${said}`),
    )
    let full = false
    if (fullPasses > 0 && own.some(o => o === null)) {
      fullPasses -= 1
      full = true
      $.ui.toast(`${LABEL}: full-size picture let through`)
    }

    // A fresh object without `ref`: returning core's own would make it send its own messages.
    const result = JSON.parse(JSON.stringify(r.result)) as unknown
    const mine = findImages(result)
    const texts = findTexts(result)
    const notes: string[] = []
    const keep = settings.mode === 'describe'
    let changed = false
    let replaced: unknown = undefined
    let newest: { card: number; base64: string } | null = null

    const work = mine.map((hit, i) => ({ hit, i, why: own[i] ?? (full ? 'let through at full size (/efficient-browser full)' : null) }))
    const todo = work.filter(w => !w.why)
    for (const w of work) if (w.why) leave(w.i, w.why)

    // The mod acts now: show the pane, and the camera moves until 2 s after the last picture.
    if (todo.length > 0) {
      void openPane($)
      await setBusy($, true).catch(() => undefined)
    }
    try {
      for (const { hit, i } of todo) {
        const { base64, mime } = bytesOf(hit.block)
        let s: Shrunk
        try {
          s = await shrink($, base64, mime, keep)
        } catch (err) {
          leave(i, 'could not be shrunk')
          void log($, `${e.tool}: could not shrink, left as is: ${err instanceof Error ? err.message : String(err)}`)
          continue
        }
        const before = imageTokens(s.w, s.h)

        if (settings.mode === 'describe') {
          try {
            const d = await describe($, s.file)
            const after = Math.ceil(d.text.length / 4)
            const note = `[${LABEL}: this ${s.w}x${s.h} picture was described in words by Haiku instead of shown. To click on it, use read_page or find, or ask the user to type /efficient-browser full and take it again.]\n${d.text}`
            if (isObj(hit.block.file)) {
              // Read: a text result in Read's own shape.
              replaced = { type: 'text', file: { filePath: String(input.file_path ?? ''), content: note, numLines: note.split('\n').length, startLine: 1, totalLines: note.split('\n').length } }
            } else {
              for (const k of Object.keys(hit.block)) delete hit.block[k]
              hit.block.type = 'text'
              hit.block.text = note
            }
            changed = true
            totals.images += 1
            totals.before += before
            totals.after += after
            cards.push({ tool: e.tool, action: 'described', w: s.w, h: s.h, before, after, note: note.slice(0, 1500), ...(id ? { toolUseId: id } : {}) })
            await ledger($, {
              tool_use_id: id,
              action: `described ${e.tool} picture ${s.w}x${s.h} in words`,
              before,
              after,
              helper: { model: 'claude-haiku-5-5', in: d.tokens, out: null, ...(d.tokens === null ? { note: 'subagent usage not reported' } : { note: 'in is the subagent total_tokens' }) },
            }).catch(err => log($, `ledger: ${String(err)}`))
            void log($, `${e.tool}: described ${s.w}x${s.h} (${before} -> ${after} tokens)`)
            $.process.run(['/bin/rm', '-f', s.file]).catch(() => undefined)
            continue
          } catch (err) {
            void log($, `describe failed, shrinking instead: ${err instanceof Error ? err.message : String(err)}`)
            $.process.run(['/bin/rm', '-f', s.file]).catch(() => undefined)
            // Fall through to shrinking.
            try {
              s = await shrink($, base64, mime, false)
            } catch {
              leave(i, 'could not be shrunk')
              continue
            }
          }
        }

        if (s.nw === undefined || s.nh === undefined || !s.base64) {
          leave(i, `already small (${s.w}x${s.h}, at most ${settings.min} px on the long side)`)
          continue
        }
        setBytes(hit.block, s.base64, s.mime, s.w, s.h, s.nw, s.nh)
        const after = imageTokens(s.nw, s.nh)
        const framed = relabel(texts, s.w, s.h, s.nw, s.nh)
        const f = Number((s.w / s.nw).toFixed(3))
        const said = notes.push(
          framed
            ? `${LABEL} shrank this screenshot from ${s.w}x${s.h} to ${s.nw}x${s.nh}. Its coordinate frame is unchanged, as the screenshot line says.`
            : `${LABEL} shrank this picture from ${s.w}x${s.h} to ${s.nw}x${s.nh}. A point (x, y) on it is (x*${f}, y*${f}) on the original.`,
        )
        changed = true
        totals.images += 1
        totals.before += before
        totals.after += after
        newest = { card: cards.length, base64: s.base64 }
        cards.push({ tool: e.tool, action: 'shrank', w: s.w, h: s.h, nw: s.nw, nh: s.nh, before, after, note: notes[said - 1], ...(id ? { toolUseId: id } : {}) })
        await ledger($, { tool_use_id: id, action: `shrank ${e.tool} picture ${s.w}x${s.h} to ${s.nw}x${s.nh}`, before, after, helper: null }).catch(err => log($, `ledger: ${String(err)}`))
        void log($, `${e.tool}: ${s.w}x${s.h} -> ${s.nw}x${s.nh} (${before} -> ${after} tokens)`)
        $.ui.toast(`${LABEL}: ${s.w}x${s.h} to ${s.nw}x${s.nh}, ~${fmt(before - after)} tokens saved`)
      }
    } finally {
      if (todo.length > 0) await setBusy($, false).catch(() => undefined)
    }

    for (const [reason, count] of alone) cards.push({ tool: e.tool, action: 'left alone', w: 0, h: 0, before: 0, after: 0, count, reason, ...(id ? { toolUseId: id } : {}) })
    await setTotals($, totals).catch(err => log($, `pane totals: ${String(err)}`))
    const ids = await addShots($, cards).catch(err => {
      void log($, `pane cards not saved (${cards.length}): ${String(err)}`)
      return [] as string[]
    })
    // The small picture comes after the result: Claude never waits on it.
    const thumbId = newest ? ids[newest.card] : undefined
    if (newest && thumbId) void thumbnail($, thumbId, newest.base64).catch(err => log($, `thumbnail: ${String(err)}`))

    if (!changed) return r
    $.ui.status(statusLine())
    if (notes.length > 0) notes.push('For small text, use zoom or read the page as text. The user can type /efficient-browser full to let one full-size picture through.')
    return { result: (replaced ?? result) as never, ...(notes.length > 0 ? { context: [notes.join('\n')] } : {}) }
  // If anything above throws, the tool's own result stands: next(e) replays it, nothing runs twice.
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'efficient-browser' }, async ($, e) => {
    if (off) return { text: `${LABEL} is off. Turn it on with /mods.` }
    const [word = '', value = ''] = e.args.trim().toLowerCase().split(/\s+/)
    const added = await showPane($)
    if (word === 'pane') {
      return {
        text: `${LABEL}: pane open. This chat: ${totals.seen} picture${totals.seen === 1 ? '' : 's'} seen, ${totals.images} shrunk.${added > 0 ? ` ${added} card(s) came back from the ledger.` : ''}`,
      }
    }
    const save = () => $.store.set('settings', settings)
    if (word === 'full') {
      fullPasses = 1
      return { text: `${LABEL}: the next picture comes through at full size. Then shrinking starts again.` }
    }
    if (word === 'shrink' || word === 'describe') {
      settings = { ...settings, mode: word }
      await save()
      if (word === 'describe') await registerDescriber($)
      return {
        text:
          word === 'shrink'
            ? `${LABEL}: shrink. Pictures come through at ${settings.scale} of their size, never under ${settings.min} px.`
            : `${LABEL}: describe. Haiku writes each picture out in words, and Claude gets no picture. Type /efficient-browser shrink to go back.`,
      }
    }
    if (word === 'scale' || word === 'min') {
      const n = Number(value)
      const ok = word === 'scale' ? n >= 0.2 && n <= 0.9 : Number.isInteger(n) && n >= 256 && n <= 1568
      if (!ok) return { text: word === 'scale' ? 'Give a scale from 0.2 to 0.9, for example /efficient-browser scale 0.5' : 'Give a size from 256 to 1568 px, for example /efficient-browser min 512' }
      settings = { ...settings, [word]: n }
      await save()
      return { text: `${LABEL}: ${word} is now ${n}.` }
    }
    return {
      text: [
        `${LABEL} is on, mode: ${settings.mode}, scale ${settings.scale}, never under ${settings.min} px.`,
        `This chat: ${totals.seen} picture${totals.seen === 1 ? '' : 's'} seen, ${totals.images} shrunk, ~${fmt(totals.before)} tokens before, ~${fmt(totals.after)} after.`,
        ...(totals.pasted > 0 ? [`${totals.pasted} pasted picture(s) went through as they were: mods cannot shrink pasted pictures.`] : []),
        'Type /efficient-browser pane, full, shrink, describe, scale 0.5 or min 512.',
      ].join('\n'),
    }
  })
}

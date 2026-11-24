import type { EngineInterface, Register } from 'claude-code'

// Vault: a second brain in an Obsidian vault, run as plain Markdown files. Obsidian never has
// to be open: Claude reads and writes the notes with its own file tools, and Obsidian shows
// them (graph, backlinks, Bases) whenever the person opens it.
//
// 1. /vault use <folder> and /vault setup para|zettel|existing make the vault: folders, a
//    CLAUDE.md with the vault's conventions, note templates and a Base.
// 2. Handoffs, research briefs and (opt-in) Input Router reads are copied into <vault>/Claude/
//    with properties and a link to their project's note. Each source file is copied once: a
//    note the person moves or deletes is never written again.
// 3. A Daily note gets one line per chat and per copied note.
// 4. Each prompt is searched against the vault (qmd BM25, else ripgrep; no model call). A strong
//    match adds a short hidden hint with the paths, never the notes themselves.
// 5. /vault save, ask, inbox and review hand Claude a prompt that works in the vault.
// Search: qmd (github.com/tobi/qmd, local BM25 + vectors + rerank) when it is installed, with a
// multilingual embedding model; ripgrep otherwise.

const NAME = 'vault'
const COLLECTION = 'vault'
const BAND = { plugin: 'vault', key: 'band' } as const
const PURPLE = '#7c3aed'
const CHOICE = { plugin: 'vault', key: 'choice' } as const
// qmd's default embedding model is tuned for English; this one covers 119 languages.
const EMBED = 'hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf'
const HINTS = 3
const FOLDERS: Record<string, string[]> = {
  para: ['Inbox', 'Projects', 'Areas', 'Resources', 'Archive', 'Daily', 'Reviews', 'Templates', 'Claude'],
  zettel: ['Inbox', 'Notes', 'MOCs', 'Sources', 'Projects', 'Daily', 'Reviews', 'Templates', 'Claude'],
  existing: ['Claude'],
}
// Words that say nothing about what a prompt is about, Portuguese and English.
const STOP = new Set(
  (
    'para pelo pela pelos pelas como mais menos muito muita muitos muitas isso isto esse essa esses essas este esta estes estas aquele aquela ' +
    'quero queria preciso pode podes poderia fazer faça faz fiz feito tenho temos tem estou está estão estava ser sido sendo foram será ' +
    'você vocês voce meu minha meus minhas seu sua seus suas nosso nossa dele dela qual quais quando onde porque porquê então entao ' +
    'quanto quanta quantos quantas agora ainda também tambem sobre entre depois antes aqui alguma algum algo tudo todo toda todos todas nada cada mesmo mesma outra outro ' +
    'sim não nao bem quer quem coisa coisas jeito forma vamos veja ver olha olhe deixa favor obrigado certo acho acha sabe saber ' +
    'that this with what from have your about would could should there their them they then than when where which while will just ' +
    'like make made want need does doing done into also some more most only other such very here please thanks know think'
  ).split(' '),
)

type Model = 'para' | 'zettel' | 'existing'
type Config = { path?: string; model?: Model; reads?: boolean; daily?: boolean }
type Hit = { path: string; why: string }
type Source = { kind: string; dir: string; to: string; skip?: RegExp }

let claudeDir = ''
let home = ''
let root = ''
let off = false
let cwd = ''
let startedAt = 0
let cfg: Config = {}
let qmd = ''
let section = ''
let logged = false
let indexedAt = 0
const hinted = new Set<string>()

const trim = (v: string | undefined) => (v ?? '').trim()
const tilde = (p: string) => (home && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p)
const expand = (p: string) => p.trim().replace(/^~(?=\/|$)/, home).replace(/\/+$/, '')
const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? ''
const vault = () => cfg.path ?? ''
const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const hm = (ms: number) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const oneLine = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

async function sh($: EngineInterface, script: string, args: string[] = [], timeoutMs = 10_000) {
  return $.process.run(['/bin/sh', '-c', script, 'sh', ...args], { timeoutMs })
}
// A true append: two chats may write the same Daily note.
async function append($: EngineInterface, path: string, text: string) {
  const r = await $.process.run(['/bin/sh', '-c', 'mkdir -p "$(dirname "$1")" && cat >> "$1"', 'sh', path], { stdin: text, timeoutMs: 10_000 })
  if (r.exitCode !== 0) throw new Error(`append to ${path} failed: ${r.stderr.slice(0, 200)}`)
}
async function log($: EngineInterface, line: string) {
  await append($, `${claudeDir}/mods-logs/vault/vault.log`, `${new Date(await $.clock.now()).toISOString()} ${line}\n`).catch(() => undefined)
}

async function setup($: EngineInterface) {
  home = trim(await $.env.get('HOME').catch(() => undefined)) || $.plugin.root.split('/.claude/')[0] || ''
  const set = trim(await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined))
  claudeDir = set ? set.replace(/^~(?=\/|$)/, home) : `${home}/.claude`
  root = $.plugin.root
  try {
    const path = `${claudeDir}/mods/switches.json`
    const raw = (await $.fs.exists(path)) ? String(await $.fs.read(path)) : ''
    off = raw ? (JSON.parse(raw) as Record<string, unknown>)[NAME] === false : false
  } catch {
    off = false
  }
  cwd = await $.session.cwd().catch(() => '')
  startedAt = await $.clock.now()
  const c = await $.store.get('config').catch(() => undefined)
  cfg = c && typeof c === 'object' ? (c as Config) : {}
  qmd = await findQmd($)
}

// The desktop app's PATH can miss the folders npm and bun install into.
async function findQmd($: EngineInterface) {
  const r = await sh(
    $,
    'command -v qmd && exit 0; for p in "$HOME/.volta/bin/qmd" "$HOME/.bun/bin/qmd" "$HOME/.npm-global/bin/qmd" "$HOME/.local/bin/qmd" "/usr/local/bin/qmd"; do [ -x "$p" ] && echo "$p" && exit 0; done; exit 1',
  ).catch(() => undefined)
  return r && r.exitCode === 0 ? trim(r.stdout.split('\n')[0]) : ''
}
const qmdEnv = () => ({ QMD_EMBED_MODEL: EMBED })

async function saveConfig($: EngineInterface, next: Config) {
  cfg = next
  await $.store.set('config', cfg)
}

// ---- project and daily notes ----

// A chat's project: its folder, unless that is home or a scratch folder.
function projectOf(folder: string) {
  if (!folder || folder === home || folder.startsWith('/tmp/') || folder.includes('/.claude/')) return ''
  return base(folder)
}
const safeName = (s: string) => s.replace(/[\\/:*?"<>|#^[\]]/g, '-').trim()

async function ensureProject($: EngineInterface, name: string, folder: string) {
  const path = `${vault()}/Projects/${safeName(name)}.md`
  if (await $.fs.exists(path)) return
  const now = await $.clock.now()
  const text = [
    '---',
    'type: project',
    `date: ${ymd(now)}`,
    'status: ativo',
    ...(folder ? [`folder: ${JSON.stringify(tilde(folder))}`] : []),
    'tags: [projeto]',
    '---',
    `# ${name}`,
    '',
    '## Objetivo',
    '',
    '',
    '## Notas do Claude sobre este projeto',
    '',
    '![[Claude.base#Do projeto]]',
    '',
  ].join('\n')
  await $.process.run(['mkdir', '-p', `${vault()}/Projects`])
  await $.fs.write(path, text)
}

async function daily($: EngineInterface, ms: number, line: string) {
  if (cfg.daily === false) return
  const day = ymd(ms)
  const path = `${vault()}/Daily/${day}.md`
  const head = (await $.fs.exists(path)) ? '' : `---\ntype: daily\ndate: ${day}\ntags: [daily]\n---\n# ${day}\n\n`
  await append($, path, `${head}- ${hm(ms)} ${line}\n`)
}

// ---- copying the other mods' notes into the vault ----

const sources = (): Source[] => [
  { kind: 'handoff', dir: `${claudeDir}/handoffs`, to: 'Claude/Handoffs', skip: /-draft\.md$/ },
  { kind: 'research', dir: `${claudeDir}/mods-logs/research-router`, to: 'Claude/Research' },
  ...(cfg.reads ? [{ kind: 'read', dir: `${claudeDir}/mods-logs/input-router`, to: 'Claude/Reads' }] : []),
]

// A handoff names its folder: "Continue work in `~/x/y`".
const handoffFolder = (text: string) => {
  const m = text.match(/Continue work in `([^`]+)`/)
  return m?.[1] ? expand(m[1]) : ''
}

function noteFor(o: { kind: string; name: string; text: string; project: string; src: string; ms: number }) {
  const title = trim(o.text.match(/^#\s+(.+)$/m)?.[1]) || o.name.replace(/\.md$/, '')
  return [
    '---',
    `type: ${o.kind}`,
    `title: ${JSON.stringify(title)}`,
    `date: ${ymd(o.ms)}`,
    ...(o.project ? [`project: "[[${safeName(o.project)}]]"`] : []),
    `source: ${JSON.stringify(tilde(o.src))}`,
    `tags: [claude, ${o.kind}]`,
    '---',
    '',
    o.text.trimEnd(),
    '',
  ].join('\n')
}

// Runs one at a time: a call waits for the one before it, then copies what is still new.
let chain: Promise<number> = Promise.resolve(0)
const mirror = ($: EngineInterface) => (chain = chain.catch(() => 0).then(() => mirrorOnce($)))
async function mirrorOnce($: EngineInterface) {
  if (off || !vault()) return 0
  {
    const prev = await $.store.get('mirrored').catch(() => undefined)
    const done = new Set(Array.isArray(prev) ? (prev as string[]) : [])
    let n = 0
    for (const s of sources()) {
      const list = await $.fs.list(s.dir).catch(() => [])
      for (const f of [...list].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
        if (f.kind !== 'file' || !f.name.endsWith('.md') || s.skip?.test(f.name)) continue
        const src = `${s.dir}/${f.name}`
        // Keyed by vault too: a vault set later still gets the older notes.
        const key = `${vault()}|${src}`
        if (done.has(key)) continue
        const text = String(await $.fs.read(src))
        // Files written in this chat belong to its folder; older ones only when they say where.
        const folder = s.kind === 'handoff' ? handoffFolder(text) : f.mtimeMs >= startedAt ? cwd : ''
        const project = projectOf(folder)
        const dest = `${vault()}/${s.to}/${f.name}`
        if (!(await $.fs.exists(dest))) {
          await $.process.run(['mkdir', '-p', `${vault()}/${s.to}`])
          await $.fs.write(dest, noteFor({ kind: s.kind, name: f.name, text, project, src, ms: f.mtimeMs }))
          if (project) await ensureProject($, project, folder)
          await daily($, f.mtimeMs, `[[${f.name.replace(/\.md$/, '')}]] (${s.kind}${project ? `, [[${safeName(project)}]]` : ''})`)
        }
        done.add(key)
        n++
      }
    }
    if (n) {
      await $.store.set('mirrored', [...done].slice(-5000))
      await log($, `copied ${n} note(s) into the vault`)
      void reindex($)
    }
    return n
  }
}

// ---- search ----

function keywords(text: string) {
  const words = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(w => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w))
  return [...new Set(words)].slice(0, 12)
}

// ripgrep: a note matches when it holds most of the prompt's words that exist in the vault at all
// (words no note has, like "responda", say nothing), in its text or its name. Rarer words rank higher.
// Run inside the vault, so the globs are anchored at its root.
const RG_GLOBS = ['-g', '*.md', '-g', '!.obsidian/**', '-g', '!/Daily/**', '-g', '!/Templates/**', '-g', '!/CLAUDE.md']
async function rgHits($: EngineInterface, terms: string[]): Promise<Hit[]> {
  const at = { timeoutMs: 3000, cwd: vault() }
  const [content, files] = await Promise.all([
    $.process.run(['rg', '-i', '-o', '--no-heading', '--with-filename', '--max-count', '30', ...RG_GLOBS, ...terms.flatMap(t => ['-e', t]), '.'], at),
    $.process.run(['rg', '--files', ...RG_GLOBS, '.'], at),
  ])
  const seen = new Map<string, Set<string>>()
  const add = (rel: string, found: string) => {
    const path = `${vault()}/${rel.replace(/^\.\//, '')}`
    for (const t of terms) if (found.includes(t)) (seen.get(path) ?? seen.set(path, new Set()).get(path)!).add(t)
  }
  for (const line of content.stdout.split('\n')) {
    const i = line.lastIndexOf(':')
    if (i > 0) add(line.slice(0, i), line.slice(i + 1).toLowerCase())
  }
  const all = files.stdout.split('\n').filter(Boolean)
  for (const rel of all) add(rel, base(rel).toLowerCase())
  const df = new Map<string, number>()
  for (const s of seen.values()) for (const t of s) df.set(t, (df.get(t) ?? 0) + 1)
  const need = Math.max(2, Math.ceil(df.size * 0.6))
  const idf = (t: string) => Math.log((all.length + 1) / (df.get(t) ?? 1))
  const score = (s: Set<string>) => [...s].reduce((sum, t) => sum + idf(t), 0)
  return [...seen.entries()]
    .filter(([, s]) => s.size >= need)
    .sort((a, b) => b[1].size - a[1].size || score(b[1]) - score(a[1]))
    .map(([path, s]) => ({ path, why: `termos: ${[...s].join(', ')}` }))
}

// qmd's vector search: finds notes that say the same thing in other words (~1 s on a CPU). Its
// scores are absolute here (unrelated prompts come back empty); 0.6 kept only real matches in tests.
// shortcut: 0.6 was tuned on a small vault, raise it if hints get noisy in a big one.
const MIN_SCORE = '0.6'
async function qmdHits($: EngineInterface, text: string): Promise<Hit[]> {
  const r = await $.process.run([qmd, 'vsearch', oneLine(text, 300), '--json', '-n', '3', '-c', COLLECTION, '--min-score', MIN_SCORE], { timeoutMs: 4000, env: qmdEnv() })
  if (r.exitCode !== 0) throw new Error(r.stderr.slice(0, 200))
  const json = JSON.parse(r.stdout.trim() || '[]') as unknown
  const rows = (Array.isArray(json) ? json : []) as Record<string, unknown>[]
  return rows
    .map(row => {
      const rel = String(row.file ?? '').replace(/^qmd:\/\/[^/]+\//, '')
      const score = typeof row.score === 'number' ? row.score : 0
      return { path: `${vault()}/${rel}`, why: `qmd ${score.toFixed(2)}` }
    })
    .filter(h => h.path !== `${vault()}/` && !/\/(Daily|Templates)\//.test(h.path))
}

async function recall($: EngineInterface, text: string): Promise<Hit[]> {
  const terms = keywords(text)
  if (terms.length < 2) return []
  // Words first (exact, milliseconds), then meaning; the two run side by side.
  const fail = (what: string) => async (err: unknown) => (await log($, `${what} failed: ${String(err)}`), [] as Hit[])
  const [words, meaning] = await Promise.all([rgHits($, terms).catch(fail('ripgrep')), qmd ? qmdHits($, text).catch(fail('qmd vsearch')) : []])
  const hits = [...words, ...meaning.filter(m => !words.some(w => w.path === m.path))]
  return hits.filter(h => !hinted.has(h.path)).slice(0, HINTS)
}

function hintText(hits: Hit[]) {
  return [
    `Vault (${tilde(vault())}): estas notas podem ter o que o pedido precisa. Se servirem, leia-as antes de pesquisar na web ou reler arquivos grandes; se não, ignore.`,
    ...hits.map(h => `- ${h.path.startsWith(`${vault()}/`) ? h.path.slice(vault().length + 1) : h.path} (${h.why})`),
  ].join('\n')
}

const searchCmd = () =>
  qmd
    ? `QMD_EMBED_MODEL=${EMBED} ${qmd} query "<pergunta>" -c ${COLLECTION} -n 8 --json (híbrida, por significado; ~5 s, timeout de 60 s). O score é relativo: o primeiro resultado vem alto mesmo sem nota sobre o assunto, então confira lendo. Grep no vault para nomes exatos.`
    : `Grep em ${vault()} (glob *.md)`

function systemSection() {
  return [
    '# Segundo cérebro (vault)',
    `O vault de notas da pessoa fica em \`${vault()}\`: Markdown puro, o Obsidian não precisa estar aberto. Quando a pessoa pedir para guardar, lembrar ou consultar algo no vault, nas notas ou no segundo cérebro, trabalhe nele e siga \`${vault()}/CLAUDE.md\`. Nunca apague notas.`,
    `Buscar no vault: ${searchCmd()}`,
  ].join('\n')
}

// ---- qmd index ----

async function ensureCollection($: EngineInterface) {
  if (!qmd || !vault()) return ''
  const list = await $.process.run([qmd, 'collection', 'list'], { timeoutMs: 15_000, env: qmdEnv() }).catch(() => undefined)
  if (list && new RegExp(`\\b${COLLECTION}\\b`).test(list.stdout)) return 'já existia'
  // Daily notes repeat the prompts and templates are empty: both would crowd out real notes.
  const r = await $.process.run([qmd, 'collection', 'add', vault(), '--name', COLLECTION, '--mask', '**/*.md,!Daily/**,!Templates/**,!CLAUDE.md'], { timeoutMs: 120_000, env: qmdEnv() })
  if (r.exitCode !== 0) throw new Error(trim(r.stderr) || trim(r.stdout))
  await $.process.run([qmd, 'context', 'add', `qmd://${COLLECTION}`, 'Segundo cérebro da pessoa: notas, projetos, pesquisas e handoffs do Claude'], { timeoutMs: 15_000, env: qmdEnv() }).catch(() => undefined)
  return 'criada'
}

// Runs detached: the first embedding of a big vault can take longer than a hook may wait.
async function reindex($: EngineInterface) {
  if (!qmd || !vault()) return
  const now = await $.clock.now()
  if (now - indexedAt < 60_000) return
  indexedAt = now
  const out = `${claudeDir}/mods-logs/vault/qmd.log`
  await sh($, 'mkdir -p "$(dirname "$2")"; (QMD_EMBED_MODEL="$3" nice "$1" update && QMD_EMBED_MODEL="$3" nice "$1" embed) >> "$2" 2>&1 < /dev/null &', [qmd, out, EMBED]).catch(err => log($, `reindex: ${String(err)}`))
}

// ---- making the vault ----

async function obsidianVaults($: EngineInterface) {
  const found: string[] = []
  for (const p of [`${home}/.config/obsidian/obsidian.json`, `${home}/.var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json`, `${home}/snap/obsidian/current/.config/obsidian/obsidian.json`]) {
    try {
      if (!(await $.fs.exists(p))) continue
      const json = JSON.parse(String(await $.fs.read(p))) as { vaults?: Record<string, { path?: string }> }
      for (const v of Object.values(json.vaults ?? {})) if (v.path && !found.includes(v.path)) found.push(v.path)
    } catch {
      // A broken obsidian.json only means no suggestion.
    }
  }
  return found
}

async function syncNotes($: EngineInterface, path: string) {
  const notes: string[] = []
  if (await $.fs.exists(`${path}/.git`)) notes.push('é um repositório git: um push leva as notas (handoffs e pesquisas incluídos) para o remoto')
  if (/dropbox|nextcloud|onedrive|google ?drive|pcloud|syncthing|icloud/i.test(path)) notes.push('fica numa pasta sincronizada com a nuvem')
  if (await $.fs.exists(`${path}/.obsidian/plugins/obsidian-git`)) notes.push('tem o plugin Obsidian Git')
  return notes
}

// Copies the template files that are not in the vault yet; never overwrites one.
async function copyTemplate($: EngineInterface, model: Model) {
  const made: string[] = []
  for (const dir of [...(model === 'existing' ? [] : [model]), 'common']) {
    const from = `${root}/template/${dir}`
    const r = await sh($, 'cd "$1" && find . -type f', [from])
    for (const rel of r.stdout.split('\n').map(l => l.replace(/^\.\//, '')).filter(Boolean)) {
      const to = `${vault()}/${rel}`
      if (await $.fs.exists(to)) continue
      await $.process.run(['mkdir', '-p', to.slice(0, to.lastIndexOf('/'))])
      await $.fs.write(to, String(await $.fs.read(`${from}/${rel}`)))
      made.push(rel)
    }
  }
  for (const f of FOLDERS[model] ?? []) await $.process.run(['mkdir', '-p', `${vault()}/${f}`])
  return made
}

// ---- setting itself up ----

// The first chat with no vault set picks one (a vault Obsidian knows, else ~/Documents/Vault) and a
// model (para for an empty folder, existing for one with notes), then says so in the band.
async function autoSetup($: EngineInterface) {
  const lines: string[] = []
  if (!cfg.path) {
    const docs = (await $.fs.exists(`${home}/Documentos`)) && !(await $.fs.exists(`${home}/Documents`)) ? 'Documentos' : 'Documents'
    let path = `${home}/${docs}/Vault`
    for (const p of [...(await obsidianVaults($)), `${home}/Documents/Vault`, `${home}/Documentos/Vault`]) {
      if (await $.fs.exists(p)) {
        path = p
        break
      }
    }
    lines.push(await useVault($, path))
  }
  if (!cfg.model) {
    const list = await $.fs.list(vault()).catch(() => [])
    const notes = list.some(f => !f.name.startsWith('.') && f.name !== 'Claude')
    // An empty folder waits for the person's pick in the band; one with notes keeps its structure.
    if (notes) lines.push(await applyModel($, 'existing', false))
    else await $.state.set(CHOICE, true).catch(() => undefined)
  }
  // The "Próximo passo" hint is for /vault use typed by hand; here the model is already set.
  const text = lines.join('\n').split('\n').filter(l => !l.startsWith('Próximo passo')).join('\n')
  await $.state.set(BAND, text).catch(() => undefined)
  await log($, `auto setup: ${oneLine(text, 200)}`)
}

// ---- the prompts /vault hands Claude ----

function promptFor(sub: string, arg: string) {
  const v = vault()
  const rules = `O vault fica em \`${v}\`; siga \`${v}/CLAUDE.md\`. Busca: ${searchCmd()}. Nunca apague notas.`
  switch (sub) {
    case 'save':
      return `${rules}\n\nGuarde no vault uma nota sobre: ${arg || 'o ponto mais importante deste chat até aqui (decisão, aprendizado ou ideia)'}.\n- Antes, busque no vault: se já houver nota com essa ideia, atualize-a em vez de criar outra.\n- Nota nova vai em \`Inbox/\`, uma ideia só, título que diz a ideia, frontmatter (type: note, date de hoje, tags, project se este chat tiver projeto) e [[links]] para as notas relacionadas que a busca achou.\n- Escreva com as minhas palavras e as decisões deste chat; não invente.\n- No fim, diga o caminho da nota.`
    case 'ask':
      return `${rules}\n\nResponda usando o meu vault: ${arg}\n- Busque primeiro e leia só as notas que importam.\n- Cite cada nota usada como [[nome]].\n- Se o vault não tiver a resposta, diga isso claramente antes de responder com o que você sabe.`
    case 'inbox':
      return `${rules}\n\nProcesse a \`Inbox/\` do vault. Para cada nota: proponha o destino (pasta, conforme o CLAUDE.md), um título melhor se precisar, tags e [[links]] para notas existentes. Mostre tudo numa lista e espere o meu ok antes de mover ou mudar qualquer coisa. Nada é apagado.`
    case 'review':
      return `${rules}\n\nFaça a revisão semanal do vault:\n- o que entrou nos últimos 7 dias (\`Daily/\` e a propriedade date);\n- projetos sem nota nova há 30 dias ou mais;\n- notas sem nenhum [[link]] de ou para elas (órfãs);\n- o tamanho da \`Inbox/\`.\nEscreva o resultado em \`Reviews/<ano>-W<semana>.md\` com links e me mostre um resumo curto. Não mova nem apague nada sem o meu ok.`
    case 'existing':
      return `${rules.replace(/; siga [^;]+;/, ';')}\n\nEste vault já existia. Estude-o: a árvore de pastas (2 níveis), 2 ou 3 notas de exemplo de cada pasta principal, o frontmatter e os templates que ele usa. Depois escreva \`${v}/CLAUDE.md\` com as convenções dele: o que vai em cada pasta, como as notas são nomeadas, o frontmatter, como as notas se ligam, e que \`Claude/\` é escrito pelos mods. Se \`${v}/CLAUDE.md\` já existir, mostre o que mudaria e espere o meu ok. Não mexa em nenhuma outra nota.`
  }
  return ''
}

// ---- /vault ----

// A prompt submitted inside command.run would wait on the turn that hook holds: a timer sends it after.
const later = ($: EngineInterface, text: string) => $.clock.after(0, () => void $.prompt.submit({ text }).catch(err => log($, `submit: ${String(err)}`)))

async function status($: EngineInterface) {
  const lines: string[] = []
  if (!vault()) {
    lines.push('Nenhum vault escolhido.')
    const found = await obsidianVaults($)
    if (found.length) lines.push('', 'Vaults que o Obsidian conhece:', ...found.map(p => `- ${tilde(p)}  →  /vault use ${tilde(p)}`))
    lines.push('', 'Para um vault novo: /vault use ~/Documentos/Vault e depois /vault setup para (ou zettel).')
  } else {
    lines.push(`Vault: ${tilde(vault())} (modelo: ${cfg.model ?? 'nenhum ainda, use /vault setup para|zettel|existing'})`)
    lines.push(`Busca: ${qmd ? `qmd (${tilde(qmd)}), híbrida, com embeddings multilíngues` : 'ripgrep, só palavras. Para busca por significado: npm install -g @tobilu/qmd e depois /vault index'}`)
    const prev = await $.store.get('mirrored').catch(() => undefined)
    lines.push(`Copiadas para Claude/: ${Array.isArray(prev) ? prev.length : 0} notas (handoffs, pesquisas${cfg.reads ? ', leituras' : ''})`)
    lines.push(`Leituras do Input Router: ${cfg.reads ? 'copiadas' : 'não copiadas (/vault reads on)'} · Nota diária: ${cfg.daily === false ? 'desligada (/vault daily on)' : 'ligada'}`)
    const sync = await syncNotes($, vault())
    if (sync.length) lines.push(`Atenção: o vault ${sync.join('; ')}.`)
  }
  lines.push(
    '',
    'Comandos: /vault save [assunto] · /vault ask <pergunta> · /vault inbox · /vault review · /vault index · /vault use <pasta> · /vault setup para|zettel|existing · /vault reads on|off · /vault daily on|off',
  )
  return lines.join('\n')
}

async function useVault($: EngineInterface, path: string) {
  await $.process.run(['mkdir', '-p', `${path}/Claude`])
  await saveConfig($, { ...cfg, path })
  let idx = ''
  try {
    idx = qmd ? `Índice do qmd: coleção "${COLLECTION}" ${await ensureCollection($)}; indexando em segundo plano.` : ''
    void reindex($)
  } catch (err) {
    idx = `O qmd não aceitou a coleção: ${String(err)}`
  }
  const sync = await syncNotes($, path)
  const copied = await mirror($)
  return [
    `Vault: ${tilde(path)}.`,
    copied ? `${copied} notas dos mods copiadas para Claude/.` : '',
    idx,
    sync.length ? `Atenção: este vault ${sync.join('; ')}.` : 'Se você sincronizar este vault (Obsidian Sync, git, nuvem), as notas que os mods gravam saem desta máquina.',
    cfg.model ? '' : 'Próximo passo: /vault setup para (PARA), /vault setup zettel (Zettelkasten) ou /vault setup existing (manter a estrutura que já existe).',
  ]
    .filter(Boolean)
    .join('\n')
}

async function applyModel($: EngineInterface, model: Model, study: boolean) {
  const made = await copyTemplate($, model)
  await saveConfig($, { ...cfg, model })
  if (model === 'existing' && study) later($, promptFor('existing', ''))
  void reindex($)
  return [
    `Modelo ${model} no vault ${tilde(vault())}.`,
    made.length ? `Criados: ${made.join(', ')}.` : 'Nenhum arquivo novo: os que já existiam ficaram como estavam.',
    model !== 'existing' ? 'As convenções estão em CLAUDE.md, na raiz do vault: edite à vontade.' : study ? 'Pedi ao Claude para estudar o vault e escrever o CLAUDE.md dele.' : 'Estrutura mantida. Para o Claude estudar o vault e escrever o CLAUDE.md dele: /vault setup existing.',
  ].join('\n')
}

async function run($: EngineInterface, args: string): Promise<{ text: string; context?: string[] }> {
  const sub = trim(args).split(/\s+/)[0] ?? ''
  const arg = trim(trim(args).slice(sub.length))
  if (!sub || sub === 'status' || sub === 'help') return { text: await status($) }

  if (sub === 'use') {
    if (!arg) return { text: 'Diga a pasta: /vault use ~/Documentos/Vault' }
    const path = expand(arg)
    if (!path.startsWith('/')) return { text: `Use um caminho completo (começando com / ou ~): ${arg}` }
    return { text: await useVault($, path), context: [`O vault de notas da pessoa agora fica em \`${path}\`.`] }
  }

  if (!vault()) return { text: await status($) }

  if (sub === 'setup') {
    const model = arg as Model
    if (!FOLDERS[model]) return { text: 'Escolha o modelo: /vault setup para · /vault setup zettel · /vault setup existing' }
    return { text: await applyModel($, model, true) }
  }

  if (sub === 'reads' || sub === 'daily') {
    const on = arg === 'on'
    if (arg !== 'on' && arg !== 'off') return { text: `/vault ${sub} on ou /vault ${sub} off` }
    await saveConfig($, { ...cfg, [sub]: on })
    const copied = sub === 'reads' && on ? await mirror($) : 0
    return { text: `${sub === 'reads' ? 'Leituras do Input Router' : 'Nota diária'}: ${on ? 'ligada' : 'desligada'}.${copied ? ` ${copied} notas copiadas.` : ''}${sub === 'reads' && on ? ' Elas resumem arquivos que você abriu: se o vault sincroniza, esses resumos vão junto.' : ''}` }
  }

  if (sub === 'index') {
    qmd = await findQmd($)
    const copied = await mirror($)
    if (!qmd) return { text: `${copied} notas copiadas. Sem qmd, a busca usa ripgrep. Para busca por significado: npm install -g @tobilu/qmd (Node 22+), depois /vault index de novo.` }
    let col = ''
    try {
      col = await ensureCollection($)
    } catch (err) {
      return { text: `O qmd não aceitou a coleção: ${String(err)}` }
    }
    indexedAt = 0
    await reindex($)
    return { text: `${copied} notas copiadas. Coleção "${COLLECTION}" ${col}; o qmd está indexando em segundo plano (log: ${tilde(`${claudeDir}/mods-logs/vault/qmd.log`)}). Na primeira vez ele baixa os modelos (~2 GB).` }
  }

  const prompt = promptFor(sub, arg)
  if (!prompt) return { text: `Não conheço /vault ${sub}.\n\n${await status($)}` }
  if (sub === 'ask' && !arg) return { text: 'Diga a pergunta: /vault ask o que decidi sobre o cache?' }
  later($, prompt)
  return { text: `Pedi ao Claude: /vault ${sub}${arg ? ` ${oneLine(arg, 60)}` : ''}` }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    hinted.clear()
    logged = false
    await setup($)
    if (!off) {
      await $.command.register({ name: 'vault', description: 'Segundo cérebro no Obsidian: guardar, perguntar, organizar e revisar notas', argumentHint: 'save|ask|inbox|review|use|setup|index' }).catch(() => undefined)
      if (!cfg.path || !cfg.model) await autoSetup($).catch(err => log($, `auto setup: ${String(err)}`))
      // Frozen for the chat: a change mid-chat would rewrite the prompt cache.
      section = vault() ? systemSection() : ''
      void mirror($).catch(err => log($, `mirror: ${String(err)}`))
      // Notes written in Obsidian since the last chat; qmd update only reads what changed.
      void reindex($)
    }
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (off || !section) return r
    return { ...r, sections: [...r.sections, { id: `${NAME}:vault`, text: section, scope: 'session' as const }] }
  })

  on('prompt.submit', async ($, e, next) => {
    if (off || !vault() || e.command || e.isMeta || e.origin?.kind === 'plugin' || e.origin?.kind === 'task-notification') return next(e)
    const typed = e.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ').trim()
    if (!typed) return next(e)
    if (!logged) {
      logged = true
      const project = projectOf(cwd)
      try {
        if (project) await ensureProject($, project, cwd)
        await daily($, await $.clock.now(), `chat${project ? ` em [[${safeName(project)}]]` : ''}: ${oneLine(typed, 100)}`)
      } catch (err) {
        await log($, `daily: ${String(err)}`)
      }
    }
    // Fail open: a search that breaks leaves the prompt as typed.
    const hits = await recall($, typed).catch(() => [] as Hit[])
    if (!hits.length) return next(e)
    for (const h of hits) hinted.add(h.path)
    await log($, `hint: ${hits.map(h => tilde(h.path)).join(', ')}`)
    return next({ ...e, context: [...(e.context ?? []), hintText(hits)] })
  })

  // Handoffs and research briefs land during a turn; copy them when it ends.
  on('turn.complete', async ($, e, next) => {
    if (!off && !e.agentId) await mirror($).catch(err => log($, `mirror: ${String(err)}`))
    return next(e)
  })

  on('command.run', { command: 'vault' }, async ($, e) => run($, e.args ?? ''))

  // The band from autoSetup: what the mod set up by itself, until the person closes it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (off || e.props.hasSurvey) return next(e)
    const { value } = await $.state.get(BAND)
    if (typeof value !== 'string' || !value) return next(e)
    const choose = (await $.state.get(CHOICE)).value === true
    const rest = await next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const [head, ...more] = value.split('\n')
    return (
      <Box flexDirection="column">
        {rest}
        <Box flexDirection="column">
          <Text>
            <Text color={PURPLE}>●</Text>
            <Text bold> Vault configurado sozinho · </Text>
            <Text color={PURPLE}>{head}</Text>
          </Text>
          {more.map((l, i) => (
            <Text key={`l${i}`} dimColor>
              {l}
            </Text>
          ))}
          <Text dimColor>Para trocar: /vault use &lt;pasta&gt; · /vault setup para|zettel|existing</Text>
          {choose ? <Text>Escolha o modelo: PARA organiza por projetos e áreas; Zettel liga ideias por links.</Text> : null}
          <Box flexDirection="row" gap={1}>
            {choose ? <Button key="para" label="PARA" variant="primary" onPress={() => undefined} /> : null}
            {choose ? <Button key="zettel" label="Zettelkasten" variant="secondary" onPress={() => undefined} /> : null}
            {choose ? null : <Button key="ok" label="Entendi" role="dismiss" onPress={() => undefined} />}
          </Box>
        </Box>
      </Box>
    )
  })

  for (const model of ['para', 'zettel'] as const)
    on('ui.press', { plugin: 'vault', element: model }, async ($, e) => {
      await $.state.set(CHOICE, null)
      await $.state.set(BAND, await applyModel($, model, false))
      return { element: e.element }
    })

  on('ui.press', { plugin: 'vault', element: 'ok' }, async ($, e) => {
    await $.state.set(BAND, null)
    return { element: e.element }
  })
}

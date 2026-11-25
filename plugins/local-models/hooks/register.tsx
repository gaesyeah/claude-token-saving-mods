import type { EngineInterface, Register } from 'claude-code'

// Local Models: qmd and its models, for every mod that uses them (vault's search, Effort Optimizer's and
// Model Router's local judge). They run on the CPU, so they cost no tokens.
// 1. With no qmd, an orange band offers to install it: Node 22 through Volta when Node is missing or
//    older (no sudo), then the package. "Agora não" is remembered; /local-models install offers it again.
// 2. With qmd, each chat start makes sure its daemon (localhost:8181) runs, so the models stay loaded.
//    With the mod off in /mods, the daemon it started is stopped.

const NAME = 'local-models'
const BAND = { plugin: 'local-models', key: 'band' } as const
const ORANGE = '#d97757'
const PKG = '@tobilu/qmd'

let home = ''
let claudeDir = ''
let off = false
let qmd = ''

const trim = (v: string | undefined) => (v ?? '').trim()
const tilde = (p: string) => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p)

async function sh($: EngineInterface, script: string, args: string[] = [], timeoutMs = 15_000) {
  return $.process.run(['/bin/sh', '-c', script, 'sh', ...args], { timeoutMs })
}

// One line through mods-core: stamped with the time, its file kept under 2 MB.
async function log($: EngineInterface, line: string) {
  await $.mods.log({ file: `${NAME}.log`, line }).catch(() => undefined)
}

async function setup($: EngineInterface) {
  ;({ home, claudeDir } = await $.mods.paths())
  off = (await $.mods.switches())[NAME] === false
  qmd = await $.mods.qmdFind().catch(() => '')
}

// qmd and its daemon live in mods-core ($.mods.qmd*); the daemon's PID is kept, so the mod stops only
// a daemon it started itself.
async function startDaemon($: EngineInterface) {
  const r = await $.mods.qmdStart()
  if (r.pid) await $.store.set('daemon', r.pid).catch(() => undefined)
  if (r.out) await log($, `qmd daemon: ${r.out}`)
}

async function stopDaemon($: EngineInterface) {
  const pid = await $.store.get('daemon').catch(() => undefined)
  if (typeof pid !== 'string' || !pid) return
  const r = await $.mods.qmdStop({ pid })
  await log($, r === 'other' ? `qmd daemon ${pid}: not the mod's any more, left alone` : `qmd daemon ${pid} stopped (mod off)`)
  await $.store.set('daemon', null).catch(() => undefined)
}

// Node 22+ already there: npm (into ~/.npm-global when npm may not write its global folder). Missing or
// older: Volta in ~/.volta, which pins the qmd it installs to its own Node 22. findQmd looks in both.
async function install($: EngineInterface) {
  await $.state.set(BAND, 'installing').catch(() => undefined)
  const r = await sh(
    $,
    'if node -v 2>/dev/null | grep -qE "^v(2[2-9]|[3-9][0-9])"; then npm install -g "$1" 2>&1 || { npm config set prefix "$HOME/.npm-global" && npm install -g "$1" 2>&1; }; else V="$HOME/.volta/bin/volta"; [ -x "$V" ] || { command -v curl >/dev/null || { echo "sem Node 22 e sem curl para instalar o Volta"; exit 3; }; curl -fsSL https://get.volta.sh | bash -s -- --skip-setup 2>&1; } && "$V" install node@22 2>&1 && "$V" install "$1" 2>&1; fi',
    [PKG],
    600_000,
  ).catch(err => ({ exitCode: 1, stdout: String(err), stderr: '' }))
  qmd = await $.mods.qmdFind({ fresh: true }).catch(() => '')
  if (!qmd) {
    const why = (trim(r.stdout).split('\n').filter(Boolean).at(-1) ?? 'erro desconhecido').slice(0, 160)
    await log($, `install failed: ${why}`)
    await $.state.set(BAND, `Não deu para instalar o qmd: ${why}. Os mods seguem sem os modelos locais. Para tentar à mão: npm install -g ${PKG}`).catch(() => undefined)
    return
  }
  await log($, `installed: ${qmd}`)
  await startDaemon($).catch(err => log($, `qmd daemon: ${String(err)}`))
  await $.state
    .set(BAND, `qmd instalado (${tilde(qmd)}). Os modelos (~2 GB) baixam sozinhos no primeiro uso. Abra um chat novo para o vault indexar as notas; o Effort Optimizer e o Model Router começam a aprender a partir de agora.`)
    .catch(() => undefined)
}

async function status($: EngineInterface) {
  if (!qmd) return `Local Models: qmd não instalado. ${(await $.store.get('declined').catch(() => undefined)) === true ? 'O aviso foi dispensado; /local-models install mostra de novo.' : 'O aviso laranja acima do chat oferece instalar.'}`
  return `Local Models: qmd em ${tilde(qmd)}; daemon ${(await $.mods.qmdUp().catch(() => false)) ? `rodando em http://localhost:8181 (~1 GB de RAM com os modelos carregados; descarrega após 5 min parado)` : 'parado (sobe no próximo chat)'}. Usado pelo vault (busca), Effort Optimizer e Model Router (juiz local).`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await setup($)
    if (off) {
      void stopDaemon($).catch(err => log($, `qmd stop: ${String(err)}`))
      return next(e)
    }
    await $.command.register({ name: NAME, description: 'qmd e os modelos locais: estado, ou install para instalar', argumentHint: 'install' }).catch(() => undefined)
    if (qmd) void startDaemon($).catch(err => log($, `qmd daemon: ${String(err)}`))
    else if ((await $.store.get('declined').catch(() => undefined)) !== true) await $.state.set(BAND, 'offer').catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: NAME }, async ($, e) => {
    if (!home) await setup($)
    if (off) return { text: 'Local Models está desligado. Ligue em /mods.' }
    if (trim(e.args) === 'install') {
      await $.store.set('declined', false).catch(() => undefined)
      if (qmd) return { text: await status($) }
      await $.state.set(BAND, 'offer')
      return { text: 'O aviso laranja para instalar o qmd está acima do chat.' }
    }
    return { text: await status($) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (off || e.props.hasSurvey) return next(e)
    const { value } = await $.state.get(BAND)
    if (typeof value !== 'string' || !value) return next(e)
    const rest = await next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const row =
      value === 'offer' ? (
        <Box flexDirection="column">
          <Text>
            <Text color={ORANGE}>●</Text>
            <Text bold> Modelos locais: </Text>
            <Text>o qmd roda no seu CPU, sem gastar tokens: o vault acha notas ditas com outras palavras, e o Effort Optimizer e o Model Router aprendem a decidir sem chamar o Sonnet e o Haiku. Instala com npm (e o Node 22 pelo Volta, em ~/.volta, se faltar ou for antigo; sem sudo) e baixa ~2 GB de modelos.</Text>
          </Text>
          <Box flexDirection="row" gap={1}>
            <Button key="install" label="Instalar qmd" variant="primary" onPress={() => undefined} />
            <Button key="later" label="Agora não" role="dismiss" onPress={() => undefined} />
          </Box>
        </Box>
      ) : value === 'installing' ? (
        <Text>
          <Text color={ORANGE}>●</Text>
          <Text> Instalando o qmd em segundo plano (pode levar alguns minutos)…</Text>
        </Text>
      ) : (
        <Box flexDirection="column">
          <Text>
            <Text color={ORANGE}>●</Text>
            <Text> {value}</Text>
          </Text>
          <Box flexDirection="row" gap={1}>
            <Button key="ok" label="Entendi" role="dismiss" onPress={() => undefined} />
          </Box>
        </Box>
      )
    return (
      <Box flexDirection="column">
        {rest}
        {row}
      </Box>
    )
  })

  on('ui.press', { plugin: 'local-models', element: 'install' }, async ($, e) => {
    void install($).catch(err => log($, `install: ${String(err)}`))
    return { element: e.element }
  })

  on('ui.press', { plugin: 'local-models', element: 'later' }, async ($, e) => {
    await $.store.set('declined', true).catch(() => undefined)
    await $.state.set(BAND, null)
    return { element: e.element }
  })

  on('ui.press', { plugin: 'local-models', element: 'ok' }, async ($, e) => {
    await $.state.set(BAND, null)
    return { element: e.element }
  })
}

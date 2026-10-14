import { useEffect, useRef, useState } from 'preact/hooks'
import { Card, CardHead } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { PasswordInput, Select } from '@/components/ui/field'
import { ask } from '@/lib/confirm'
import { errText, notify, request } from '@/lib/api'
import { t } from '@/lib/i18n'
import { usePoll } from '@/lib/poll'
import { store, ls } from '@/lib/store'

type Release = { version: string; firmware: string; channel: string; url: string; size: number; notes: string }
type Catalog = { schema: number; expires: number; releases: Release[] }
type Status = {
  enabled: boolean
  ready: boolean
  busy: boolean
  installed: string
  firmware: string
  job: string
  phase: string
  version: string
}
const status = store<{ data: Status | null }>({ data: null })
const refresh = async () => status.set({ data: await request('/api/app-update/status') })
const source =
  'https://raw.githubusercontent.com/Neme77/centauri-carbon-2-community/develop/cc2-control/update-channel.cc2catalog'
const urlPattern =
  /^https:\/\/github\.com\/Neme77\/centauri-carbon-2-community\/releases\/download\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.cc2update$/
const validVersion = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/
export const newer = (candidate: string, installed: string) => {
  if (!validVersion.test(candidate) || !validVersion.test(installed)) return false
  const a = candidate.split('.').map(Number),
    b = installed.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}
export const compatible = (index: Catalog | null, firmware: string, channel: string): Release[] => {
  if (
    index?.schema !== 1 ||
    !Number.isSafeInteger(index.expires) ||
    index.expires <= Date.now() / 1000 ||
    !Array.isArray(index.releases)
  )
    return []
  return index.releases
    .filter(
      r =>
        r.firmware === firmware &&
        r.channel === channel &&
        validVersion.test(r.version) &&
        urlPattern.test(r.url) &&
        Number.isSafeInteger(r.size) &&
        r.size >= 1108 &&
        r.size <= 33555540 &&
        typeof r.notes === 'string' &&
        r.notes.length <= 2048
    )
    .sort((a, b) => (newer(a.version, b.version) ? -1 : newer(b.version, a.version) ? 1 : 0))
}

async function checkIndex() {
  const response = await fetch(source, {
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  })
  if (response.status === 404) return null
  if (!response.ok || !response.body) throw Error(t('updates.check_failed'))
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.length
      if (total > 8264) throw Error(t('updates.check_failed'))
      chunks.push(value)
    }
  } finally {
    await reader.cancel()
  }
  return request('/api/app-update/catalog', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Blob(chunks as BlobPart[]),
  })
}

export const Updates = () => {
  usePoll(refresh, 2000)
  const state = status.use().data
  const [channel, setChannel] = useState(ls.get('cc2-update-channel') === 'canvas-uds' ? 'canvas-uds' : 'stable')
  const [index, setIndex] = useState<Catalog | null>(null),
    [checking, setChecking] = useState(false)
  const [working, setWorking] = useState(false),
    [code, setCode] = useState(''),
    [error, setError] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const mounted = useRef(true),
    selection = useRef(0)
  const release = compatible(index, state?.firmware || '', channel)[0]
  const available = release && newer(release.version, state?.installed || '')
  const busy = working || Boolean(state?.busy)
  const runCheck = async (force = true) => {
    setChecking(true)
    setError('')
    try {
      const cached = await request('/api/app-update/catalog')
      const last = Number(ls.get('cc2-update-checked') || 0)
      const result =
        !force && Date.now() - last < 6 * 3600000 && cached.expires > Date.now() / 1000 ? cached : await checkIndex()
      if (mounted.current) setIndex(result)
      if (result) ls.set('cc2-update-checked', String(Date.now()))
    } catch (e) {
      if (mounted.current) setError(errText(e))
    } finally {
      if (mounted.current) setChecking(false)
    }
  }
  useEffect(() => {
    mounted.current = true
    void runCheck(false)
    return () => {
      mounted.current = false
    }
  }, [])
  const changeChannel = async (next: string) => {
    if (next === 'canvas-uds' && !(await ask(t('updates.experimental_warning')))) return
    selection.current++
    setChannel(next)
    setFile(null)
    ls.set('cc2-update-channel', next)
  }
  const prepare = async (local: boolean) => {
    if (!state?.ready || !code.trim() || busy || (local ? !file : !available)) return
    if (!(await ask(t('updates.prepare_confirm')))) return
    const chosen = selection.current
    setWorking(true)
    setError('')
    try {
      if (chosen !== selection.current) return
      await request(local ? '/api/app-update/upload' : '/api/app-update/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-CC2-LAN': code.trim() },
        body: local ? file : release.url,
        signal: AbortSignal.timeout(300000),
      })
      await refresh()
      notify(t('updates.verified'))
    } catch (e) {
      setError(errText(e))
    } finally {
      if (mounted.current) setWorking(false)
    }
  }
  const install = async () => {
    if (
      !state?.ready ||
      state.phase !== 'ready' ||
      !code.trim() ||
      busy ||
      !(await ask(t('updates.install_confirm'), true))
    )
      return
    setWorking(true)
    setError('')
    try {
      await request('/api/app-update/install', {
        method: 'POST',
        headers: { 'X-CC2-LAN': code.trim() },
        body: state.job,
      })
      setCode('')
      notify(t('updates.restarting'))
      await refresh()
    } catch (e) {
      setError(errText(e))
    } finally {
      if (mounted.current) setWorking(false)
    }
  }
  return (
    <Card>
      <CardHead icon="settings" title="updates.title" sub="updates.application_only" />
      <div class="grid gap-4 cc2-sm:grid-cols-2">
        <div>
          <span class="text-muted">{t('updates.installed')}</span>
          <b class="mt-1 block">{state?.installed || '—'}</b>
        </div>
        <label>
          {t('updates.channel')}
          <Select
            aria-label={t('updates.channel')}
            class="mt-1"
            value={channel}
            disabled={busy}
            onChange={e => {
              const next = e.currentTarget.value
              e.currentTarget.value = channel
              void changeChannel(next)
            }}
          >
            <option value="stable">{t('updates.stable')}</option>
            <option value="canvas-uds">{t('updates.experimental')}</option>
          </Select>
        </label>
      </div>
      <div class="my-4 flex flex-wrap items-center gap-3">
        <Button disabled={checking || busy || !state?.enabled} onClick={() => void runCheck()}>
          {t('updates.check')}
        </Button>
        <span>
          {checking
            ? t('updates.checking')
            : available
              ? `${t('updates.available')}: ${release.version}`
              : t('updates.no_update')}
        </span>
      </div>
      {release && <p class="whitespace-pre-wrap break-words text-muted">{release.notes}</p>}
      {!state?.enabled && <p class="my-3 text-amber">{t('updates.bootstrap')}</p>}
      <p class="my-3 text-sm text-muted">{t('updates.requirements')}</p>
      <label class="block max-w-md" htmlFor="update-lan-code">
        {t('settings.lan_access_code')}
        <PasswordInput
          id="update-lan-code"
          class="mt-1"
          value={code}
          disabled={busy}
          onInput={e => setCode(e.currentTarget.value)}
          autoComplete="off"
        />
      </label>
      <div class="my-4 flex flex-wrap gap-3">
        <Button disabled={!available || !state?.ready || !code.trim() || busy} onClick={() => void prepare(false)}>
          {t('updates.download')}
        </Button>
        <Button
          disabled={state?.phase !== 'ready' || !state.ready || !code.trim() || busy}
          onClick={() => void install()}
        >
          {t('updates.install')}
        </Button>
      </div>
      <details class="border-t border-edge pt-3">
        <summary class="cursor-pointer">{t('updates.local_file')}</summary>
        <input
          class="my-3 block max-w-full"
          type="file"
          accept=".cc2update"
          disabled={busy}
          onChange={e => {
            const selected = e.currentTarget.files?.[0] || null
            selection.current++
            setFile(selected && selected.size >= 1108 && selected.size <= 33555540 ? selected : null)
          }}
        />
        <Button disabled={!file || !state?.ready || !code.trim() || busy} onClick={() => void prepare(true)}>
          {t('updates.verify_file')}
        </Button>
      </details>
      <p class="mt-4">
        {t('updates.status')}{' '}
        {t(
          state?.phase === 'complete'
            ? 'updates.complete'
            : state?.phase === 'failed' || state?.phase === 'interrupted'
              ? 'updates.failed'
              : state?.phase === 'ready'
                ? 'updates.verified'
                : busy
                  ? 'updates.working'
                  : 'updates.idle'
        )}
      </p>
      {state?.version && (
        <p>
          {t('updates.selected')} {state.version}
        </p>
      )}
      {state?.phase === 'complete' && (
        <Button class="mt-3" onClick={() => location.reload()}>
          {t('updates.reload')}
        </Button>
      )}
      {error && (
        <p class="mt-3 break-words text-red" role="alert">
          {error}
        </p>
      )}
    </Card>
  )
}

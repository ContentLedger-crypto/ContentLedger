import type { PublisherDomains } from '@contentledger/shared'
import { type FormEvent, type ReactNode, useState } from 'react'
import { Column, FieldLabel, Line, Section } from '@/components/Primitives'
import { useDomains } from '@/hooks/useDomains'
import { useIsNarrow } from '@/hooks/useIsNarrow'
import { type Registration, useRegistration } from '@/hooks/useRegistration'
import type { RegistrationSource } from '@/lib/api'
import { formatCount, formatUsdc } from '@/lib/format'
import {
  type Draft,
  domainDraft,
  hostOfSource,
  type RateFields,
  stopText,
  type TransactionSender,
  workDraft,
} from '@/lib/register'
import { COLOR } from '@/lib/theme'

type Domain = PublisherDomains['domains'][number]

const INTRO =
  'Registering puts a domain or a work on the on-chain registry under this wallet. The gateway checks it and prepares the transaction; the wallet signs it and pays the network fee and the rent for the new account. Once it is confirmed, agents pay this wallet for what they take.'
const DOMAIN_PROSE =
  'A domain carries the base rates: every work under it is charged these unless it sets its own. This wallet owns the domain and receives its payouts.'
const WORK_PROSE =
  'A work is one address under a domain of yours. The gateway reads it and records the hash of what it serves, so every receipt can say whether the bytes served are the bytes registered.'
const PREVIEW_PROSE = 'Registration needs a wallet signed in to a gateway; the preview has neither.'

interface RegisterProps {
  readonly source: RegistrationSource
  /** `null` in the preview: there is no wallet to sign with. */
  readonly send: TransactionSender | null
  /** Where the session's transactions go, `solana:devnet`. */
  readonly chain: string
  readonly onUnauthorized?: () => void
}

export function Register({ source, send, chain, onUnauthorized }: RegisterProps) {
  const narrow = useIsNarrow()
  const { read, reread } = useDomains(source, onUnauthorized)
  const registration = useRegistration({
    source,
    send,
    chain,
    onRegistered: reread,
    onUnauthorized,
  })
  const domains = read.status === 'read' ? read.domains : []
  const locked = send === null || registration.busy

  return (
    <Column>
      <Section>
        <div style={{ maxWidth: 640 }}>
          <h1 className="serif" style={{ fontSize: narrow ? 26 : 34, fontWeight: 400 }}>
            Register
          </h1>
          <p className="serif mt-4" style={{ fontSize: narrow ? 17 : 19, color: COLOR.muted }}>
            {INTRO}
          </p>
          {send === null && (
            <p className="serif mt-4" style={{ fontSize: 16, color: COLOR.muted }}>
              {PREVIEW_PROSE}
            </p>
          )}
        </div>
      </Section>

      <Section ruled>
        <Heading narrow={narrow}>Your domains</Heading>
        <Domains read={read} narrow={narrow} />
      </Section>

      <Section ruled>
        <Heading narrow={narrow}>A domain</Heading>
        <Prose>{DOMAIN_PROSE}</Prose>
        <DomainForm
          locked={locked}
          onSubmit={registration.start}
          progress={<Progress registration={registration.current} kind="domain" />}
        />
      </Section>

      <Section ruled>
        <Heading narrow={narrow}>A work</Heading>
        <Prose>{WORK_PROSE}</Prose>
        {read.status === 'read' && domains.length === 0 ? (
          <Prose>Register a domain first: a work is registered under one.</Prose>
        ) : (
          <WorkForm
            domains={domains}
            locked={locked}
            onSubmit={registration.start}
            progress={<Progress registration={registration.current} kind="work" />}
          />
        )}
      </Section>
    </Column>
  )
}

function Domains({
  read,
  narrow,
}: {
  read: ReturnType<typeof useDomains>['read']
  narrow: boolean
}) {
  if (read.status === 'reading') return <Prose>Reading the registry…</Prose>
  if (read.status === 'failed') {
    return <Prose>The registry could not be read just now. The forms below still work.</Prose>
  }
  if (read.domains.length === 0) {
    return <Prose>No domains are registered to this wallet yet.</Prose>
  }
  return (
    <div style={{ borderTop: `1px solid ${COLOR.hairline}` }}>
      {read.domains.map((domain) => (
        <div
          key={domain.address}
          className="flex flex-col gap-1 py-4 md:flex-row md:items-baseline md:justify-between md:gap-8"
          style={{ borderBottom: `1px solid ${COLOR.hairline}` }}
        >
          <div className="flex items-baseline gap-3">
            <span className="serif" style={{ fontSize: narrow ? 18 : 20 }}>
              {domain.host}
            </span>
            {domain.status === 'suspended' && (
              <span className="serif" style={{ color: COLOR.muted, fontSize: 14 }}>
                not licensing
              </span>
            )}
          </div>
          <div
            className="fig flex flex-col md:flex-row md:gap-8"
            style={{ fontSize: 15, textAlign: narrow ? 'left' : 'right' }}
          >
            <span>Training {formatUsdc(domain.rateTrain)}</span>
            <span>Inference {formatUsdc(domain.rateInference)}</span>
            <span style={{ color: COLOR.muted }}>
              {formatCount(domain.works)} {domain.works === 1 ? 'work' : 'works'}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

function DomainForm({
  locked,
  onSubmit,
  progress,
}: {
  locked: boolean
  onSubmit: (request: Extract<Draft, { ok: true }>['request']) => void
  progress: ReactNode
}) {
  const [form, setForm] = useState({ host: '', rateTrain: '', rateInference: '' })
  const [invalid, setInvalid] = useState<Extract<Draft, { ok: false }> | null>(null)
  const edit = (field: keyof typeof form) => (value: string) => {
    setForm((previous) => ({ ...previous, [field]: value }))
    setInvalid(null)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const draft = domainDraft(form)
    if (draft.ok) onSubmit(draft.request)
    else setInvalid(draft)
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      className="mt-6 flex flex-col gap-6"
      style={{ maxWidth: 560 }}
    >
      <Field
        label="Domain"
        value={form.host}
        onChange={edit('host')}
        placeholder="example.org"
        problem={invalid?.field === 'host' ? invalid.problem : null}
      />
      <Rates form={form} edit={edit} invalid={invalid} placeholder="0.001500" />
      <Submit locked={locked}>Prepare and sign</Submit>
      {progress}
    </form>
  )
}

function WorkForm({
  domains,
  locked,
  onSubmit,
  progress,
}: {
  domains: readonly Domain[]
  locked: boolean
  onSubmit: (request: Extract<Draft, { ok: true }>['request']) => void
  progress: ReactNode
}) {
  const [form, setForm] = useState({ source: '', rateTrain: '', rateInference: '' })
  const [invalid, setInvalid] = useState<Extract<Draft, { ok: false }> | null>(null)
  const edit = (field: keyof typeof form) => (value: string) => {
    setForm((previous) => ({ ...previous, [field]: value }))
    setInvalid(null)
  }
  const host = hostOfSource(form.source)
  const domain = domains.find((candidate) => candidate.host === host) ?? null
  const example = domains[0]?.host ?? 'example.org'

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const draft = workDraft(form)
    if (draft.ok) onSubmit(draft.request)
    else setInvalid(draft)
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      className="mt-6 flex flex-col gap-6"
      style={{ maxWidth: 560 }}
    >
      <Field
        label="Address"
        value={form.source}
        onChange={edit('source')}
        placeholder={`https://${example}/2026/10/a-work`}
        problem={invalid?.field === 'source' ? invalid.problem : null}
      />
      <Rates
        form={form}
        edit={edit}
        invalid={invalid}
        placeholder="the domain’s rate"
        hint={
          domain === null
            ? 'Leave a rate empty for the work to take its domain’s.'
            : `Leave a rate empty for the work to take ${domain.host}’s: training ${formatUsdc(domain.rateTrain)}, inference ${formatUsdc(domain.rateInference)}.`
        }
      />
      <Submit locked={locked}>Prepare and sign</Submit>
      {progress}
    </form>
  )
}

function Rates({
  form,
  edit,
  invalid,
  placeholder,
  hint,
}: {
  form: RateFields
  edit: (field: 'rateTrain' | 'rateInference') => (value: string) => void
  invalid: Extract<Draft, { ok: false }> | null
  placeholder: string
  hint?: string
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Field
          label="Training, USDC per request"
          value={form.rateTrain}
          onChange={edit('rateTrain')}
          placeholder={placeholder}
          figure
          problem={invalid?.field === 'rateTrain' ? invalid.problem : null}
        />
        <Field
          label="Inference, USDC per request"
          value={form.rateInference}
          onChange={edit('rateInference')}
          placeholder={placeholder}
          figure
          problem={invalid?.field === 'rateInference' ? invalid.problem : null}
        />
      </div>
      {hint !== undefined && (
        <p className="serif" style={{ color: COLOR.muted, fontSize: 14 }}>
          {hint}
        </p>
      )}
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  problem,
  figure = false,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  problem: string | null
  figure?: boolean
}) {
  return (
    <label className="flex flex-col gap-1">
      <FieldLabel>{label}</FieldLabel>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        inputMode={figure ? 'decimal' : 'url'}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={problem !== null}
        className={figure ? 'fig entry' : 'serif entry'}
        style={{
          width: '100%',
          minWidth: 0,
          background: 'none',
          border: 'none',
          borderBottom: `1px solid ${problem === null ? COLOR.hairline : COLOR.sage}`,
          color: COLOR.ink,
          fontSize: 17,
          padding: '6px 0',
          textAlign: 'left',
          outline: 'none',
        }}
      />
      {problem !== null && (
        <span role="alert" className="serif" style={{ color: COLOR.sage, fontSize: 14 }}>
          {problem}
        </span>
      )}
    </label>
  )
}

function Submit({ locked, children }: { locked: boolean; children: string }) {
  return (
    <div>
      <button
        type="submit"
        disabled={locked}
        className="navitem"
        style={{
          color: locked ? COLOR.muted : COLOR.sage,
          background: 'none',
          border: `1px solid ${locked ? COLOR.hairline : COLOR.sage}`,
          padding: '10px 18px',
          cursor: locked ? 'default' : 'pointer',
        }}
      >
        {children}
      </button>
    </div>
  )
}

function Progress({
  registration,
  kind,
}: {
  registration: Registration | null
  kind: Registration['kind']
}) {
  if (registration === null || registration.kind !== kind) return null
  const { step } = registration
  const what = kind === 'domain' ? 'The domain' : 'The work'

  const said = (() => {
    switch (step.phase) {
      case 'preparing':
        return 'The gateway is checking it and preparing the transaction…'
      case 'signing':
        return 'Waiting for the wallet. It shows the fee and the rent before anything is sent.'
      case 'confirming':
        return step.lost
          ? 'The gateway is not answering; still asking. The transaction may already have landed.'
          : 'Sent. Waiting for the network to confirm it…'
      case 'registered':
        return kind === 'domain'
          ? `Registered. ${what} is on the registry under this wallet; works can be registered under it now.`
          : `Registered. ${what} is on the registry, and agents can license it from now on.`
      case 'stopped':
        return stopText(step.stop)
    }
  })()

  const signature = 'signature' in step ? step.signature : null

  return (
    <div
      role={step.phase === 'stopped' ? 'alert' : 'status'}
      style={{ borderLeft: `2px solid ${COLOR.sage}`, paddingLeft: 14 }}
    >
      <p className="serif" style={{ fontSize: 17 }}>
        {said}
      </p>
      {step.phase === 'registered' && <Line label="Account" value={step.address} mono copyable />}
      {signature !== null && <Line label="Transaction" value={signature} mono copyable />}
    </div>
  )
}

function Heading({ narrow, children }: { narrow: boolean; children: string }) {
  return (
    <h2 className="serif" style={{ fontSize: narrow ? 22 : 28, fontWeight: 400, marginBottom: 12 }}>
      {children}
    </h2>
  )
}

function Prose({ children }: { children: string }) {
  return (
    <p className="serif" style={{ color: COLOR.muted, fontSize: 16, maxWidth: 640 }}>
      {children}
    </p>
  )
}

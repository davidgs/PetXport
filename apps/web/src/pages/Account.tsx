import { SMS_DISCLOSURE, formatPhone, type SecuritySettings } from '@petxport/shared';
import { browserSupportsWebAuthn, startRegistration, type PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { PhotoCard } from '../components/Avatar';
import { ThemeToggle } from '../components/ThemeToggle';
import { Badge, Button, Card, ErrorNote, Field, Input, Notice, Spinner } from '../components/ui';
import { api, errorMessage, useMe } from '../lib/api';
import { fmtDate } from '../lib/format';

const METHOD_LABEL = { off: 'Off', email: 'Code by email', sms: 'Code by text message' } as const;

function TwoStep({ settings, refresh, email }: { settings: SecuritySettings; refresh: () => Promise<unknown>; email: string }) {
  const [mode, setMode] = useState<null | 'email' | 'sms' | 'off'>(null);
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [pending, setPending] = useState<{ challengeId: string; sentTo: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const reset = () => {
    setMode(null);
    setPassword('');
    setPending(null);
    setCode('');
    setError('');
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      if (mode === 'off') {
        await api('/me/2fa/disable', { body: { password } });
        await refresh();
        reset();
        setNotice('Two-step sign-in is off.');
      } else if (!pending) {
        setPending(await api('/me/2fa/setup', { body: { method: mode, password, phone: mode === 'sms' ? phone : undefined } }));
      } else {
        await api('/me/2fa/confirm', { body: { challengeId: pending.challengeId, code } });
        await refresh();
        reset();
        setNotice('Two-step sign-in is on. You will be asked for a code each time you log in with your password.');
      }
    });
  };

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Two-step sign-in</h2>
        <Badge tone={settings.twoFactor === 'off' ? 'slate' : 'green'}>
          {METHOD_LABEL[settings.twoFactor]}
          {settings.twoFactor === 'sms' && settings.phoneHint ? ` (${settings.phoneHint})` : ''}
        </Badge>
      </div>
      <p className="text-sm text-slate-600">After your password, we send a 6-digit code that you enter to finish logging in. Someone who learns your password still cannot get in.</p>
      {notice && !mode && <Notice>{notice}</Notice>}
      {!mode ? (
        <div className="flex flex-wrap gap-2">
          {settings.twoFactor !== 'email' && (
            <Button variant="secondary" onClick={() => (setNotice(''), setMode('email'))}>
              Use email codes
            </Button>
          )}
          {settings.smsAvailable && (
            <Button variant="secondary" onClick={() => (setNotice(''), setMode('sms'))}>
              {settings.twoFactor === 'sms' ? 'Change phone number' : 'Use text message codes'}
            </Button>
          )}
          {settings.twoFactor !== 'off' && (
            <Button variant="danger" onClick={() => (setNotice(''), setMode('off'))}>
              Turn off
            </Button>
          )}
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3 rounded-lg bg-slate-50 p-3">
          <input type="email" name="email" autoComplete="username" value={email} readOnly hidden />
          {!pending ? (
            <>
              <p className="text-sm font-medium">
                {mode === 'off' ? 'Turn off two-step sign-in' : mode === 'sms' ? 'Codes by text message' : 'Codes by email'}
              </p>
              {mode === 'sms' && (
                <Field label="Mobile number" hint={`You get one text each time you log in. ${SMS_DISCLOSURE} If you lose this phone you can still get a code by email.`}>
                  <Input type="tel" name="tel" autoComplete="tel" required value={phone} onChange={(e) => setPhone(e.target.value)} onBlur={() => setPhone(formatPhone(phone))} placeholder="(919) 555-0123" />
                </Field>
              )}
              <Field label="Your password, to confirm it is you">
                <Input type="password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
            </>
          ) : (
            <Field label={`Enter the code we sent to ${pending.sentTo}`}>
              <Input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={8} required autoFocus value={code} onChange={(e) => setCode(e.target.value)} className="max-w-40 text-center text-lg tracking-[0.3em]" />
            </Field>
          )}
          <ErrorNote error={error} />
          <div className="flex gap-2">
            <Button type="submit" disabled={busy} variant={mode === 'off' ? 'danger' : 'primary'}>
              {busy ? 'Working…' : mode === 'off' ? 'Turn off' : pending ? 'Confirm' : 'Send me a code'}
            </Button>
            <Button variant="ghost" onClick={reset}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

function Passkeys({ settings, refresh, email }: { settings: SecuritySettings; refresh: () => Promise<unknown>; email: string }) {
  const [adding, setAdding] = useState(false);
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const supported = browserSupportsWebAuthn();

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { challengeId, options } = await api<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }>('/me/passkeys/options', { body: { password } });
      const response = await startRegistration({ optionsJSON: options });
      await api('/me/passkeys', { body: { challengeId, response, name: name.trim() || 'Passkey' } });
      await refresh();
      setAdding(false);
      setPassword('');
      setName('');
    } catch (err) {
      if (err instanceof Error && err.name === 'InvalidStateError') setError('This device already has a passkey for your account.');
      else if (!(err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'AbortError'))) setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string, label: string) => {
    if (!window.confirm(`Remove the passkey “${label}”? It will no longer be able to log in.`)) return;
    setError('');
    try {
      await api(`/me/passkeys/${id}`, { method: 'DELETE' });
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">Passkeys</h2>
      <p className="text-sm text-slate-600">
        Log in with your fingerprint, face or device PIN instead of a password. A passkey stays on your device (or in its password manager), cannot be guessed, and only ever works on
        this site, so it cannot be phished.
      </p>
      {settings.passkeys.length > 0 && (
        <ul className="divide-y divide-slate-100 rounded-lg ring-1 ring-slate-200">
          {settings.passkeys.map((k) => (
            <li key={k.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{k.name}</p>
                <p className="text-xs text-slate-500">
                  Added {fmtDate(k.createdAt)} · {k.lastUsedAt ? `last used ${fmtDate(k.lastUsedAt)}` : 'not used yet'}
                </p>
              </div>
              <Button small variant="danger" onClick={() => remove(k.id, k.name)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {!supported && <p className="text-sm text-slate-500">This browser does not support passkeys.</p>}
      {supported && !adding && (
        <Button variant="secondary" onClick={() => setAdding(true)}>
          Add a passkey
        </Button>
      )}
      {adding && (
        <form onSubmit={add} className="space-y-3 rounded-lg bg-slate-50 p-3">
          <input type="email" name="email" autoComplete="username" value={email} readOnly hidden />
          <Field label="A name for this passkey" hint="So you can tell your devices apart later.">
            <Input name="passkey-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="My iPhone" />
          </Field>
          <Field label="Your password, to confirm it is you">
            <Input type="password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              {busy ? 'Follow your device’s prompt…' : 'Continue'}
            </Button>
            <Button variant="ghost" onClick={() => (setAdding(false), setError(''))}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      <ErrorNote error={error} />
    </Card>
  );
}

/** Sign-in settings for the account itself, the same whichever organization you are working in. */
export function Account() {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const security = useQuery({ queryKey: ['security'], queryFn: () => api<SecuritySettings>('/me/security'), enabled: Boolean(me.data) });
  if (me.isLoading) return <Spinner />;
  if (!me.data) return <Navigate to="/login?next=/account" replace />;
  const refresh = () => qc.invalidateQueries({ queryKey: ['security'] });
  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-8">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <img src="/icon.svg" alt="" className="h-9 w-9" />
          <div>
            <h1 className="text-xl font-semibold leading-tight">Account security</h1>
            <p className="text-sm text-slate-500">
              {me.data.user.name} · {me.data.user.email}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle className="text-slate-500 hover:bg-slate-100" />
          <button type="button" onClick={() => navigate(-1)} className="text-sm font-medium text-brand-700 hover:underline">
            Back
          </button>
        </div>
      </div>
      <PhotoCard />
      {security.isLoading && <Spinner />}
      <ErrorNote error={security.error} />
      {security.data && (
        <>
          <Passkeys settings={security.data} refresh={refresh} email={me.data.user.email} />
          <TwoStep settings={security.data} refresh={refresh} email={me.data.user.email} />
          <Card>
            <h2 className="mb-1 font-semibold">Password</h2>
            <p className="text-sm text-slate-600">
              To change your password, log out and use <Link to="/forgot" className="font-medium text-brand-700 hover:underline">Forgot your password?</Link> on the log-in page. Changing it
              signs you out everywhere else.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}

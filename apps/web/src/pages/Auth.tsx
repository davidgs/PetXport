import { SMS_DISCLOSURE, SMS_OPT_IN_LABEL, formatPhone, type TwoFactorStep } from '@petxport/shared';
import { browserSupportsWebAuthn, startAuthentication, type PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Button, Checkbox, ErrorNote, Field, Input, Notice, Spinner } from '../components/ui';
import { ThemeToggle } from '../components/ThemeToggle';
import { LegalLinks } from './Legal';
import { api, errorMessage } from '../lib/api';

function AuthShell({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="relative flex min-h-full flex-col items-center justify-center px-4 py-10">
      <ThemeToggle className="absolute right-3 top-3 text-slate-500 hover:bg-slate-100" />
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <img src="/icon.svg" alt="" className="h-10 w-10" />
          <span className="text-2xl font-semibold tracking-tight text-brand-900">PetXport</span>
        </div>
        <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <h1 className="mb-4 text-lg font-semibold">{title}</h1>
          {children}
        </div>
        {footer && <div className="mt-4 text-center text-sm text-slate-600">{footer}</div>}
        <LegalLinks className="mt-4 text-center" />
      </div>
    </div>
  );
}

function useSubmit(fn: () => Promise<void>) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
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
  return { error, busy, onSubmit };
}

const link = 'font-medium text-brand-700 hover:underline';

/** Second step after the password: the code that was emailed or texted. */
function CodeStep({ first, onDone, onBack }: { first: TwoFactorStep; onDone: () => Promise<void>; onBack: () => void }) {
  const [step, setStep] = useState(first);
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState('');
  const { error, busy, onSubmit } = useSubmit(async () => {
    await api('/auth/2fa', { body: { challengeId: step.challengeId, code } });
    await onDone();
  });
  const [resendError, setResendError] = useState('');
  const resend = async (channel?: 'email') => {
    setResendError('');
    setNotice('');
    try {
      const res = await api<{ twoFactor: TwoFactorStep }>('/auth/2fa/resend', { body: { challengeId: step.challengeId, channel } });
      setStep(res.twoFactor);
      setCode('');
      setNotice('A new code is on its way.');
    } catch (err) {
      setResendError(errorMessage(err));
    }
  };
  return (
    <AuthShell title="Enter your code">
      <form onSubmit={onSubmit} className="space-y-4">
        <p className="text-sm text-slate-600">
          We {step.channel === 'sms' ? 'texted' : 'emailed'} a 6-digit code to <strong>{step.sentTo}</strong>. It works for 10 minutes.
        </p>
        <Field label="Code">
          <Input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 \-]*"
            maxLength={8}
            required
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="text-center text-lg tracking-[0.4em]"
          />
        </Field>
        <ErrorNote error={error || resendError} />
        {notice && <Notice>{notice}</Notice>}
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? 'Checking…' : 'Log in'}
        </Button>
        <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-sm">
          <button type="button" className={link} onClick={() => resend()}>
            Send a new code
          </button>
          {step.canUseEmail && (
            <button type="button" className={link} onClick={() => resend('email')}>
              Email it instead
            </button>
          )}
          <button type="button" className={link} onClick={onBack}>
            Start again
          </button>
        </div>
      </form>
    </AuthShell>
  );
}

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [twoFactor, setTwoFactor] = useState<TwoFactorStep | null>(null);
  const [passkeyError, setPasskeyError] = useState('');
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const finish = async () => {
    await qc.invalidateQueries();
    const next = params.get('next');
    navigate(next?.startsWith('/') && !next.startsWith('//') ? next : '/app', { replace: true });
  };
  const { error, busy, onSubmit } = useSubmit(async () => {
    setPasskeyError('');
    const res = await api<{ twoFactor?: TwoFactorStep }>('/auth/login', { body: { email, password } });
    if (res.twoFactor) setTwoFactor(res.twoFactor);
    else await finish();
  });
  const withPasskey = async () => {
    setPasskeyError('');
    try {
      const { challengeId, options } = await api<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>('/auth/passkey/options', { body: {} });
      const response = await startAuthentication({ optionsJSON: options });
      await api('/auth/passkey', { body: { challengeId, response } });
      await finish();
    } catch (err) {
      // Closing the browser's passkey prompt is not an error worth showing.
      if (err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'AbortError')) return;
      setPasskeyError(errorMessage(err));
    }
  };
  if (twoFactor) return <CodeStep first={twoFactor} onDone={finish} onBack={() => setTwoFactor(null)} />;
  return (
    <AuthShell
      title="Log in"
      footer={
        <>
          New here? <Link to="/signup" className={link}>Create an account</Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        {params.has('reset') && <Notice>Your password was changed. Log in with it to continue.</Notice>}
        <Field label="Email">
          <Input type="email" name="email" autoComplete="username webauthn" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password">
          <Input type="password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <ErrorNote error={error || passkeyError} />
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? 'Logging in…' : 'Log in'}
        </Button>
        {browserSupportsWebAuthn() && (
          <Button variant="secondary" className="w-full" onClick={withPasskey}>
            Log in with a passkey
          </Button>
        )}
        <p className="text-center text-sm">
          <Link to="/forgot" className={link}>Forgot your password?</Link>
        </p>
      </form>
    </AuthShell>
  );
}

/** Opens in a new tab so a half-filled form is not lost. */
const LegalLink = ({ to, children }: { to: string; children: ReactNode }) => (
  <a href={to} target="_blank" rel="noopener" className="underline hover:text-slate-700">
    {children}
  </a>
);

/** Shown above the button on forms that create an account. */
const AgreeLine = () => (
  <p className="text-xs text-slate-500">
    By creating an account you agree to the <LegalLink to="/terms">Terms and Conditions</LegalLink> and <LegalLink to="/privacy">Privacy Policy</LegalLink>.
  </p>
);

/**
 * The phone number everyone gives, and beside it the separate, optional agreement to text
 * messages. The box always starts empty: agreeing has to be something the person does.
 */
function PhoneAndTexts({ phone, setPhone, optIn, setOptIn }: { phone: string; setPhone: (v: string) => void; optIn: boolean; setOptIn: (v: boolean) => void }) {
  // Nobody is asked to agree to texts on a server that does not send any.
  const texts = useQuery({ queryKey: ['features'], queryFn: () => api<{ sms: boolean }>('/features'), staleTime: 60_000 }).data?.sms ?? false;
  return (
    <div className="space-y-2">
      <Field label="Mobile number" hint="Shown to your rescue's coordinators and to the drivers you hand off to or receive from.">
        <Input
          type="tel"
          name="tel"
          autoComplete="tel"
          inputMode="tel"
          required
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          onBlur={() => setPhone(formatPhone(phone))}
          placeholder="(919) 555-0123"
        />
      </Field>
      {texts && (
        <>
          <Checkbox label={SMS_OPT_IN_LABEL} checked={optIn} onChange={setOptIn} />
          <p className="text-xs text-slate-500">
            {SMS_DISCLOSURE} See our <LegalLink to="/privacy">Privacy Policy</LegalLink> and <LegalLink to="/terms">Terms and Conditions</LegalLink>.
          </p>
        </>
      )}
    </div>
  );
}

export function Signup() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [smsOptIn, setSmsOptIn] = useState(false);
  const [sent, setSent] = useState(false);
  const { error, busy, onSubmit } = useSubmit(async () => {
    await api('/auth/signup', { body: { name, email, password, phone, smsOptIn } });
    setSent(true);
  });
  if (sent) {
    return (
      <AuthShell title="Check your email" footer={<Link to="/login" className={link}>Back to log in</Link>}>
        <Notice>
          We sent a link to <strong>{email}</strong>. Open it and enter your password to finish creating your account. It works for 24 hours.
        </Notice>
        <p className="mt-3 text-sm text-slate-500">Nothing after a few minutes? Check your spam folder. If you already have an account with this address, the email will say so.</p>
      </AuthShell>
    );
  }
  return (
    <AuthShell
      title="Create your account"
      footer={
        <>
          Already have one? <Link to="/login" className={link}>Log in</Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <Notice>Invited by a rescue? Use the link in your invitation email instead, so you land in the right team.</Notice>
        <Field label="Your name">
          <Input name="name" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Email">
          <Input type="email" name="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password" hint="At least 10 characters.">
          <Input type="password" name="new-password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <PhoneAndTexts phone={phone} setPhone={setPhone} optIn={smsOptIn} setOptIn={setSmsOptIn} />
        <AgreeLine />
        <ErrorNote error={error} />
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? 'Creating…' : 'Create account'}
        </Button>
      </form>
    </AuthShell>
  );
}

/** Second half of signing up: the emailed link, plus the password chosen at sign-up. */
export function Verify() {
  const { token = '' } = useParams();
  const [password, setPassword] = useState('');
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { error, busy, onSubmit } = useSubmit(async () => {
    await api('/auth/verify', { body: { token, password } });
    await qc.invalidateQueries();
    navigate('/app', { replace: true });
  });
  return (
    <AuthShell title="Confirm your email" footer={<Link to="/login" className={link}>Back to log in</Link>}>
      <form onSubmit={onSubmit} className="space-y-4">
        <p className="text-sm text-slate-600">Enter the password you chose when you signed up. This confirms the account is yours.</p>
        <Field label="Password">
          <Input type="password" name="password" autoComplete="current-password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <ErrorNote error={error} />
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? 'Confirming…' : 'Confirm and log in'}
        </Button>
      </form>
    </AuthShell>
  );
}

export function Forgot() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const { error, busy, onSubmit } = useSubmit(async () => {
    await api('/auth/forgot', { body: { email } });
    setSent(true);
  });
  return (
    <AuthShell title="Reset your password" footer={<Link to="/login" className={link}>Back to log in</Link>}>
      {sent ? (
        <Notice>If there is an account for {email}, a reset link is on its way. It works for 2 hours.</Notice>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="Email">
            <Input type="email" name="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <ErrorNote error={error} />
          <Button type="submit" disabled={busy} className="w-full">
            Email me a reset link
          </Button>
        </form>
      )}
    </AuthShell>
  );
}

export function Reset() {
  const { token = '' } = useParams();
  const [password, setPassword] = useState('');
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { error, busy, onSubmit } = useSubmit(async () => {
    const res = await api<{ loginRequired: boolean }>('/auth/reset', { body: { token, password } });
    await qc.invalidateQueries();
    // With two-step sign-in on, a reset link alone does not log you in.
    navigate(res.loginRequired ? '/login?reset' : '/app', { replace: true });
  });
  return (
    <AuthShell title="Choose a new password">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="New password" hint="At least 10 characters.">
          <Input type="password" name="new-password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <ErrorNote error={error} />
        <Button type="submit" disabled={busy} className="w-full">
          Save and log in
        </Button>
      </form>
    </AuthShell>
  );
}

interface InviteInfo {
  orgName: string;
  orgSlug: string;
  email: string;
  name: string;
  role: 'admin' | 'coordinator' | 'driver';
  needsPassword: boolean;
}

export function Invite() {
  const { token = '' } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const info = useQuery({ queryKey: ['invite', token], queryFn: () => api<InviteInfo>(`/invites/${token}`), retry: false });
  const [name, setName] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [smsOptIn, setSmsOptIn] = useState(false);
  const { error, busy, onSubmit } = useSubmit(async () => {
    const body = info.data?.needsPassword ? { name: name ?? info.data.name, password, phone, smsOptIn } : {};
    const { slug, role, loginRequired } = await api<{ slug: string; role: string; loginRequired: boolean }>(`/invites/${token}/accept`, { body });
    await qc.invalidateQueries();
    // An existing account is not signed in by the link; the organization page asks them to log in if needed.
    if (loginRequired) return navigate(`/o/${slug}`, { replace: true });
    // Drivers start by filling in their details; whoever runs the rescue starts at its home page.
    navigate(role === 'driver' ? `/o/${slug}/profile?welcome=1` : `/o/${slug}?welcome=1`, { replace: true });
  });
  if (info.isLoading) return <Spinner />;
  if (info.error || !info.data) {
    return (
      <AuthShell title="Invitation not found" footer={<Link to="/login" className={link}>Go to log in</Link>}>
        <ErrorNote error={info.error} />
      </AuthShell>
    );
  }
  return (
    <AuthShell title={info.data.role === 'admin' ? `Set up ${info.data.orgName}` : `Join ${info.data.orgName}`}>
      <form onSubmit={onSubmit} className="space-y-4">
        <p className="text-sm text-slate-600">
          You were invited as <strong>{info.data.email}</strong>{' '}
          {info.data.role === 'admin'
            ? 'to run this organization on PetXport: its drivers, transports and settings.'
            : info.data.role === 'coordinator'
              ? 'to help coordinate volunteer transports.'
              : 'as a volunteer driver.'}
        </p>
        {/* Not shown; lets a password manager file the new password under the right address. */}
        <input type="email" name="email" autoComplete="username" value={info.data.email} readOnly hidden />
        {info.data.needsPassword && (
          <>
            <Field label="Your name">
              <Input name="name" autoComplete="name" required value={name ?? info.data.name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Choose a password" hint="At least 10 characters.">
              <Input type="password" name="new-password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <PhoneAndTexts phone={phone} setPhone={setPhone} optIn={smsOptIn} setOptIn={setSmsOptIn} />
            <AgreeLine />
          </>
        )}
        {!info.data.needsPassword && <p className="text-sm text-slate-600">You already have a PetXport account, so after joining you log in with your usual password.</p>}
        <ErrorNote error={error} />
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? 'Joining…' : `Join ${info.data.orgName}`}
        </Button>
      </form>
    </AuthShell>
  );
}

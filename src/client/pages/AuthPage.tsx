import { useEffect, useState, type FormEvent } from 'react';
import { FileText } from 'lucide-react';
import { USERNAME_HINT, MIN_PASSWORD_LENGTH, type AuthConfig, type User } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { checkConfirm, checkName, checkNewPassword, checkUsername, compact, type Errors } from '../lib/validation';
import { Field } from '../components/Field';

type Mode = 'signin' | 'signup';

/** Maps an API error onto the form: field-specific when the server names a field. */
function errorsFrom<K extends string>(err: unknown, fields: readonly K[]): Errors<K> {
  const e = err as ApiError;
  const field = e.field as K | undefined;
  return field && fields.includes(field) ? ({ [field]: e.message } as Errors<K>) : ({ form: e.message } as Errors<K>);
}

export function AuthPage({ onSignedIn }: { onSignedIn: (user: User) => void }) {
  const [mode, setMode] = useState<Mode>('signin');
  const [demo, setDemo] = useState<AuthConfig['demo']>(null);

  useEffect(() => {
    api.authConfig().then(
      (c) => setDemo(c.demo),
      () => setDemo(null),
    );
  }, []);

  return (
    <main className="login">
      <div className="login-card">
        <div className="login-brand">
          <span className="brand-mark">
            <FileText size={20} />
          </span>
          <h1>Ajaia Docs</h1>
        </div>

        <div className="auth-tabs" role="tablist" aria-label="Account">
          <button role="tab" aria-selected={mode === 'signin'} className={mode === 'signin' ? 'is-active' : ''} onClick={() => setMode('signin')}>
            Sign in
          </button>
          <button role="tab" aria-selected={mode === 'signup'} className={mode === 'signup' ? 'is-active' : ''} onClick={() => setMode('signup')}>
            Create account
          </button>
        </div>

        {mode === 'signin' ? (
          <SignInForm demo={demo} onSignedIn={onSignedIn} onCreateAccount={() => setMode('signup')} />
        ) : (
          <SignUpForm onSignedIn={onSignedIn} onSignIn={() => setMode('signin')} />
        )}
      </div>
    </main>
  );
}

function SignInForm(props: { demo: AuthConfig['demo']; onSignedIn: (u: User) => void; onCreateAccount: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Errors<'username' | 'password'>>({});
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const found = compact<'username' | 'password'>({
      username: username.trim() ? undefined : 'Enter your username.',
      password: password ? undefined : 'Enter your password.',
    });
    setErrors(found);
    if (Object.keys(found).length) return;

    setBusy(true);
    try {
      const { user } = await api.login(username, password);
      props.onSignedIn(user);
    } catch (err) {
      setErrors(errorsFrom(err, ['username', 'password'] as const));
      setPassword('');
      setBusy(false);
    }
  };

  const fillDemo = (name: string) => {
    setUsername(name);
    setPassword(props.demo!.password);
    setErrors({});
  };

  return (
    <form className="auth-form" onSubmit={submit} noValidate>
      <Field
        label="Username"
        name="username"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        autoFocus
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        error={errors.username}
      />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={errors.password}
      />
      {errors.form && (
        <p className="form-error form-error-box" role="alert">
          {errors.form}
        </p>
      )}
      <button className="btn btn-primary btn-block" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <p className="auth-switch">
        New here?{' '}
        <button type="button" className="link-btn" onClick={props.onCreateAccount}>
          Create an account
        </button>
      </p>

      {props.demo && (
        <div className="demo-box">
          <p>
            <strong>Demo accounts</strong> for trying sharing. Password for all three:{' '}
            <code>{props.demo.password}</code>
          </p>
          <div className="demo-chips">
            {props.demo.usernames.map((u) => (
              <button key={u} type="button" className="chip" onClick={() => fillDemo(u)}>
                Use {u}
              </button>
            ))}
          </div>
          <p className="muted">Alice owns “Q4 Launch Plan” and shares it with Bob (can edit) and Carol (can view).</p>
        </div>
      )}
    </form>
  );
}

type SignUpField = 'name' | 'username' | 'password' | 'confirm';

function SignUpForm(props: { onSignedIn: (u: User) => void; onSignIn: () => void }) {
  const [values, setValues] = useState({ name: '', username: '', password: '', confirm: '' });
  const [errors, setErrors] = useState<Errors<SignUpField>>({});
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);

  const validate = (v: typeof values) =>
    compact<SignUpField>({
      name: checkName(v.name),
      username: checkUsername(v.username),
      password: checkNewPassword(v.password, v.username),
      confirm: checkConfirm(v.password, v.confirm),
    });

  // After the first submit attempt, re-check as the person fixes things.
  const set = (key: SignUpField) => (e: { target: { value: string } }) => {
    const next = { ...values, [key]: e.target.value };
    setValues(next);
    if (submitted) setErrors(validate(next));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    const found = validate(values);
    setErrors(found);
    if (Object.keys(found).length) return;

    setBusy(true);
    try {
      const { user } = await api.register({ name: values.name, username: values.username, password: values.password });
      props.onSignedIn(user);
    } catch (err) {
      setErrors(errorsFrom(err, ['name', 'username', 'password'] as const));
      setBusy(false);
    }
  };

  return (
    <form className="auth-form" onSubmit={submit} noValidate>
      <Field label="Your name" name="name" autoComplete="name" autoFocus value={values.name} onChange={set('name')} error={errors.name} />
      <Field
        label="Username"
        name="username"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        hint={`${USERNAME_HINT} Others use it to share documents with you.`}
        value={values.username}
        onChange={set('username')}
        error={errors.username}
      />
      <Field
        label="Password"
        name="new-password"
        type="password"
        autoComplete="new-password"
        hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
        value={values.password}
        onChange={set('password')}
        error={errors.password}
      />
      <Field
        label="Confirm password"
        name="confirm-password"
        type="password"
        autoComplete="new-password"
        value={values.confirm}
        onChange={set('confirm')}
        error={errors.confirm}
      />
      {errors.form && (
        <p className="form-error form-error-box" role="alert">
          {errors.form}
        </p>
      )}
      <button className="btn btn-primary btn-block" disabled={busy}>
        {busy ? 'Creating account…' : 'Create account'}
      </button>
      <p className="auth-switch">
        Already have an account?{' '}
        <button type="button" className="link-btn" onClick={props.onSignIn}>
          Sign in
        </button>
      </p>
    </form>
  );
}

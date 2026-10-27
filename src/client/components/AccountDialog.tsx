import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Info, LogOut, X } from 'lucide-react';
import { MIN_PASSWORD_LENGTH, type User } from '../../shared/types';
import { api, ApiError } from '../lib/api';
import { checkConfirm, checkNewPassword, compact, type Errors } from '../lib/validation';
import { Avatar } from './Avatar';
import { Field } from './Field';
import { useToast } from './Toasts';

type PwField = 'currentPassword' | 'newPassword' | 'confirm';

export function AccountDialog({ user, onClose, onSignOut }: { user: User; onClose: () => void; onSignOut: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const notify = useToast();
  const [isDemo, setIsDemo] = useState(false);
  const [values, setValues] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [errors, setErrors] = useState<Errors<PwField>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    dialogRef.current?.showModal();
    // showModal() focuses the first button (Close); start in the first password box instead.
    dialogRef.current?.querySelector<HTMLInputElement>('input')?.focus();
    api.authConfig().then((c) => setIsDemo(!!c.demo?.usernames.includes(user.username)), () => {});
  }, [user.username]);

  const close = () => dialogRef.current?.close();
  const set = (key: PwField) => (e: { target: { value: string } }) => setValues((v) => ({ ...v, [key]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const found = compact<PwField>({
      currentPassword: values.currentPassword ? undefined : 'Enter your current password.',
      newPassword:
        checkNewPassword(values.newPassword, user.username) ??
        (values.newPassword === values.currentPassword ? 'Choose a password different from your current one.' : undefined),
      confirm: checkConfirm(values.newPassword, values.confirm),
    });
    setErrors(found);
    if (Object.keys(found).length) return;

    setBusy(true);
    try {
      await api.changePassword(values.currentPassword, values.newPassword);
      notify('Password changed. Other devices were signed out.');
      close();
    } catch (err) {
      const e = err as ApiError;
      const field = e.field as PwField | undefined;
      setErrors(field ? { [field]: e.message } : { form: e.message });
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="dialog"
      onClose={onClose}
      onClick={(e) => e.target === dialogRef.current && close()}
      aria-labelledby="account-title"
    >
      <div className="dialog-body">
        <div className="dialog-head">
          <h2 id="account-title">Your account</h2>
          <button className="icon-btn" aria-label="Close" onClick={close}>
            <X size={18} />
          </button>
        </div>

        <div className="account-summary">
          <Avatar user={user} size={44} />
          <div>
            <strong>{user.name}</strong>
            <span>@{user.username}</span>
          </div>
          <button className="btn btn-sm" onClick={onSignOut}>
            <LogOut size={14} /> Sign out
          </button>
        </div>

        <h3 className="section-label">Change password</h3>
        {isDemo ? (
          <p className="banner banner-info account-note">
            <Info size={16} />
            <span>Demo accounts share one password, so it can’t be changed here. Create your own account to try this.</span>
          </p>
        ) : (
          <form className="auth-form" onSubmit={submit} noValidate>
            <Field
              label="Current password"
              type="password"
              autoComplete="current-password"
              value={values.currentPassword}
              onChange={set('currentPassword')}
              error={errors.currentPassword}
            />
            <Field
              label="New password"
              type="password"
              autoComplete="new-password"
              hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
              value={values.newPassword}
              onChange={set('newPassword')}
              error={errors.newPassword}
            />
            <Field
              label="Confirm new password"
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
            <p className="muted account-fineprint">Changing your password signs you out on every other device.</p>
            <div className="dialog-foot">
              <button type="button" className="btn" onClick={close}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={busy}>
                {busy ? 'Saving…' : 'Change password'}
              </button>
            </div>
          </form>
        )}
      </div>
    </dialog>
  );
}

import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { HttpError } from '@/lib/client-api';
export function SecurityForm({
  password = false,
  passwordLabel = 'Senha atual',
  disabled = false,
  factor = false,
  recovery = false,
  submit,
  onSubmit,
}: {
  password?: boolean;
  passwordLabel?: string;
  disabled?: boolean;
  factor?: boolean;
  recovery?: boolean;
  submit: string;
  onSubmit: (values: { password: string; code: string }) => Promise<void>;
}) {
  const [error, setError] = useState('');
  const fieldId = useId();
  const schema = z
    .object({ password: z.string().max(128), code: z.string().trim().max(32) })
    .superRefine((value, ctx) => {
      if (password && !value.password)
        ctx.addIssue({ code: 'custom', path: ['password'], message: 'Informe sua senha atual.' });
      if (factor && !(recovery ? value.code.length >= 5 : /^\d{6}$/.test(value.code)))
        ctx.addIssue({
          code: 'custom',
          path: ['code'],
          message: recovery
            ? 'Informe um código de recuperação.'
            : 'Informe os seis números do autenticador.',
        });
    });
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { password: '', code: '' },
  });
  return (
    <form
      className="security-form"
      onSubmit={form.handleSubmit(async (values) => {
        setError('');
        try {
          await onSubmit(values);
          form.reset();
        } catch (cause) {
          setError(
            cause instanceof HttpError && cause.status === 429
              ? cause.message
              : 'Não foi possível confirmar. Verifique a senha e o código e tente novamente.',
          );
        }
      })}
      noValidate
    >
      {password && (
        <div className="form-field">
          <Label htmlFor={`${fieldId}-password`}>{passwordLabel}</Label>
          <Input
            id={`${fieldId}-password`}
            type="password"
            autoComplete="current-password"
            {...form.register('password')}
            aria-invalid={Boolean(form.formState.errors.password)}
            aria-describedby={`${fieldId}-password-error`}
            disabled={disabled}
          />
          <p id={`${fieldId}-password-error`} className="field-error">
            {form.formState.errors.password?.message}
          </p>
        </div>
      )}
      {factor && (
        <div className="form-field">
          <Label htmlFor={`${fieldId}-code`}>
            {recovery ? 'Código de recuperação' : 'Código do autenticador'}
          </Label>
          <Input
            id={`${fieldId}-code`}
            autoComplete="one-time-code"
            inputMode={recovery ? 'text' : 'numeric'}
            maxLength={recovery ? 32 : 6}
            {...form.register('code')}
            aria-invalid={Boolean(form.formState.errors.code)}
            aria-describedby={`${fieldId}-code-error`}
          />
          <p id={`${fieldId}-code-error`} className="field-error">
            {form.formState.errors.code?.message}
          </p>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" disabled={disabled || form.formState.isSubmitting}>
        {form.formState.isSubmitting ? 'Confirmando…' : submit}
      </Button>
    </form>
  );
}

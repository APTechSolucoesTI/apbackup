import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { LockKeyhole, ShieldCheck, ArrowRight } from 'lucide-react';
import { Brand, ThemeToggle } from '@/components/app-shell';
import { SecurityForm } from '@/components/security-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, HttpError, resultSchema } from '@/lib/client-api';
export const Route = createFileRoute('/login')({ component: Login });
const credentials = z.object({
  email: z.email('Informe um e-mail válido.').trim().toLowerCase(),
  password: z.string().min(1, 'Informe sua senha.').max(128),
});
function Login() {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const [challenge, setChallenge] = useState(false),
    [recovery, setRecovery] = useState(false),
    [error, setError] = useState('');
  const form = useForm<z.infer<typeof credentials>>({
    resolver: zodResolver(credentials),
    defaultValues: { email: '', password: '' },
  });
  const enter = () => window.location.assign('/');
  return (
    <div className="login-layout">
      <section className="login-story">
        <Brand />
        <div>
          <span className="eyebrow">CONTINUIDADE, COM EVIDÊNCIA</span>
          <h2>
            Recuperar começa
            <br />
            antes do incidente.
          </h2>
          <p>Origens, destinos e pontos de recuperação em um só catálogo operacional.</p>
          <div className="login-principle">
            <ShieldCheck aria-hidden="true" />
            <span>
              Verificação por ponto e destino.
              <br />
              Decisões com escopo e rastreabilidade.
            </span>
          </div>
        </div>
        <span className="login-story-footer">APBackup · Backup & recuperação</span>
      </section>
      <main className="login-main">
        <div className="login-theme">
          <ThemeToggle />
        </div>
        <div className="login-card">
          <div className="mobile-brand">
            <Brand />
          </div>
          <div className="login-lock">
            <LockKeyhole aria-hidden="true" />
          </div>
          <h1>{challenge ? 'Verifique sua identidade' : 'Acesse o console'}</h1>
          <p>
            {challenge
              ? 'Confirme o segundo fator para concluir o acesso.'
              : 'Entre com a conta autorizada da sua organização.'}
          </p>
          {challenge ? (
            <>
              <SecurityForm
                key={recovery ? 'recovery' : 'totp'}
                factor
                recovery={recovery}
                submit="Verificar e entrar"
                onSubmit={async (values) => {
                  await api(
                    recovery
                      ? '/api/auth/two-factor/verify-backup-code'
                      : '/api/auth/two-factor/verify-totp',
                    resultSchema,
                    { code: values.code },
                  );
                  enter();
                }}
              />
              <Button variant="link" onClick={() => setRecovery(!recovery)}>
                {recovery ? 'Usar autenticador' : 'Usar código de recuperação'}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setChallenge(false);
                  form.resetField('password');
                }}
              >
                Voltar ao acesso
              </Button>
            </>
          ) : (
            <form
              className="login-form"
              noValidate
              onSubmit={form.handleSubmit(async (values) => {
                setError('');
                try {
                  const result = await api(
                    '/api/auth/sign-in/email',
                    z.object({ twoFactorRedirect: z.boolean().optional() }).passthrough(),
                    values,
                  );
                  form.resetField('password');
                  if (result.twoFactorRedirect) setChallenge(true);
                  else enter();
                } catch (cause) {
                  setError(
                    cause instanceof HttpError && cause.status === 429
                      ? cause.message
                      : 'Não foi possível entrar. Confira seu e-mail e sua senha.',
                  );
                }
              })}
            >
              <div className="form-field">
                <Label htmlFor="email">E-mail</Label>
                <Input
                  id="email"
                  type="email"
                  disabled={!ready}
                  autoComplete="username"
                  {...form.register('email')}
                  aria-invalid={Boolean(form.formState.errors.email)}
                  aria-describedby="email-error"
                />
                <p id="email-error" className="field-error">
                  {form.formState.errors.email?.message}
                </p>
              </div>
              <div className="form-field">
                <Label htmlFor="password">Senha</Label>
                <Input
                  id="password"
                  type="password"
                  disabled={!ready}
                  autoComplete="current-password"
                  {...form.register('password')}
                  aria-invalid={Boolean(form.formState.errors.password)}
                  aria-describedby="login-password-error"
                />
                <p id="login-password-error" className="field-error">
                  {form.formState.errors.password?.message}
                </p>
              </div>
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              <Button type="submit" disabled={!ready || form.formState.isSubmitting}>
                {form.formState.isSubmitting ? 'Entrando…' : 'Entrar'}
                <ArrowRight aria-hidden="true" />
              </Button>
            </form>
          )}
          <div className="login-help">
            <strong>Precisa recuperar o acesso?</strong>
            <p>
              Use um código de recuperação no segundo fator. Se perdeu os dois fatores, solicite
              recuperação ao administrador responsável pela instalação.
            </p>
          </div>
        </div>
        <footer>Acesso restrito · Sessão protegida</footer>
      </main>
    </div>
  );
}

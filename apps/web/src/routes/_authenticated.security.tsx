import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { ShieldCheck, KeyRound, Copy, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { api, resultSchema } from '@/lib/client-api';
import { Route as ProtectedRoute } from './_authenticated';
import { SecurityForm } from '@/components/security-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
export const Route = createFileRoute('/_authenticated/security')({ component: Security });
const enrollment = z.object({
  totpURI: z.string().startsWith('otpauth://'),
  backupCodes: z.array(z.string()),
});
function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <div className="recovery-codes">
      <h3>Códigos de recuperação</h3>
      <p>
        Guarde em um local seguro fora deste dispositivo. Cada código funciona uma única vez. Eles
        não ficam salvos neste navegador.
      </p>
      <pre aria-label="Códigos de recuperação">{codes.join('\n')}</pre>
      <Button
        variant="outline"
        onClick={() =>
          void navigator.clipboard
            .writeText(codes.join('\n'))
            .then(() => toast.success('Códigos copiados. Guarde-os em local seguro.'))
            .catch(() => toast.error('Selecione e copie os códigos manualmente.'))
        }
      >
        <Copy aria-hidden="true" />
        Copiar códigos
      </Button>
    </div>
  );
}
function Security() {
  const { identity } = ProtectedRoute.useRouteContext(),
    router = useRouter();
  const [setup, setSetup] = useState<z.infer<typeof enrollment> | null>(null),
    [codes, setCodes] = useState<string[] | null>(null),
    [recovery, setRecovery] = useState(false),
    [proofUntil, setProofUntil] = useState(0),
    [fresh, setFresh] = useState(false),
    [confirmDisable, setConfirmDisable] = useState(false),
    [busy, setBusy] = useState(false),
    [confirmed, setConfirmed] = useState(false);
  const enabled = identity.status === 'ok' && identity.session.mfaEnabled;
  useEffect(() => {
    const tick = () => setFresh(proofUntil > Date.now());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [proofUntil]);
  const refresh = async () => {
    await router.invalidate();
  };
  return (
    <>
      <div className="page-eyebrow">CONTA / SEGURANÇA</div>
      <div className="page-header">
        <div>
          <h1>Segurança da conta</h1>
          <p>Autenticação em duas etapas e confirmação de identidade para operações sensíveis.</p>
        </div>
      </div>
      <div className="security-grid">
        <section className="settings-card">
          <div className="section-title">
            <ShieldCheck aria-hidden="true" />
            <h2>Autenticador</h2>
          </div>
          {enabled ? (
            <>
              <p className="success-message">
                <ShieldCheck aria-hidden="true" />
                Autenticação em duas etapas ativa
              </p>
              <p>
                Sua senha e um código temporário são exigidos no acesso. Guarde seus códigos de
                recuperação fora deste dispositivo.
              </p>
            </>
          ) : setup ? (
            <>
              <h3>Conecte seu aplicativo autenticador</h3>
              <p>
                No aplicativo, adicione uma conta com chave de configuração, selecione códigos por
                tempo e informe a chave abaixo.
              </p>
              <Label htmlFor="setup-key">Chave de configuração</Label>
              <Input
                id="setup-key"
                className="font-mono"
                readOnly
                value={new URL(setup.totpURI).searchParams.get('secret') ?? ''}
              />
              <RecoveryCodes codes={setup.backupCodes} />
              <label className="confirmation-label">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                Guardei os códigos de recuperação em local seguro.
              </label>
              {confirmed ? (
                <SecurityForm
                  factor
                  submit="Confirmar ativação"
                  onSubmit={async (values) => {
                    await api('/api/auth/two-factor/verify-totp', resultSchema, {
                      code: values.code,
                    });
                    setSetup(null);
                    setConfirmed(false);
                    await refresh();
                    toast.success('Autenticação em duas etapas ativada.');
                  }}
                />
              ) : (
                <p className="support-text">Guarde os códigos antes de confirmar a ativação.</p>
              )}
              <Button
                variant="ghost"
                onClick={() => {
                  setSetup(null);
                  setConfirmed(false);
                }}
              >
                Fechar configuração
              </Button>
            </>
          ) : (
            <>
              <p>
                Adicione um aplicativo autenticador para proteger sua conta e liberar a confirmação
                exigida por operações sensíveis.
              </p>
              <SecurityForm
                password
                submit="Configurar autenticador"
                onSubmit={async (values) => {
                  setSetup(
                    await api('/api/auth/two-factor/enable', enrollment, {
                      password: values.password,
                    }),
                  );
                }}
              />
            </>
          )}
          {codes && (
            <>
              <RecoveryCodes codes={codes} />
              <Button variant="ghost" onClick={() => setCodes(null)}>
                Já guardei os códigos
              </Button>
            </>
          )}
        </section>
        <section className="settings-card">
          <div className="section-title">
            <KeyRound aria-hidden="true" />
            <h2>Confirmar identidade</h2>
          </div>
          <p>
            A confirmação vale por cinco minutos nesta sessão. Operações sensíveis também verificam
            suas permissões no servidor.
          </p>
          {enabled ? (
            <>
              <Button variant="link" onClick={() => setRecovery(!recovery)}>
                {recovery ? 'Usar autenticador' : 'Usar código de recuperação'}
              </Button>
              <SecurityForm
                key={recovery ? 'recovery' : 'totp'}
                password
                factor
                recovery={recovery}
                submit="Confirmar identidade"
                onSubmit={async (values) => {
                  await api(
                    '/api/reauthenticate',
                    z.object({ verified: z.literal(true), validForSeconds: z.number() }),
                    {
                      password: values.password,
                      ...(recovery ? { recoveryCode: values.code } : { code: values.code }),
                    },
                  );
                  setProofUntil(Date.now() + 300000);
                  await refresh();
                }}
              />
              {fresh && (
                <p role="status" className="success-message">
                  Identidade confirmada por até cinco minutos.
                </p>
              )}
              <div className="sensitive-actions">
                <h3>Gerenciar o segundo fator</h3>
                <p>
                  Confirme sua identidade acima antes de continuar. Novos códigos substituem todos
                  os anteriores.
                </p>
                <SecurityForm
                  password
                  passwordLabel="Senha para novos códigos"
                  disabled={!fresh}
                  submit="Gerar novos códigos"
                  onSubmit={async (values) => {
                    if (!fresh) throw new Error('Reauthenticate');
                    const result = await api(
                      '/api/auth/two-factor/generate-backup-codes',
                      z.object({ backupCodes: z.array(z.string()) }),
                      { password: values.password },
                    );
                    setCodes(result.backupCodes);
                    toast.success('Novos códigos gerados. Os anteriores foram invalidados.');
                  }}
                />
                <Button
                  variant="outline"
                  disabled={!fresh || busy}
                  onClick={() => setConfirmDisable(true)}
                >
                  Desativar duas etapas
                </Button>
                {!fresh && (
                  <p className="support-text">
                    Confirme sua identidade para gerenciar o segundo fator.
                  </p>
                )}
              </div>
            </>
          ) : (
            <div className="inline-notice">
              <AlertTriangle aria-hidden="true" />
              <p>Configure e verifique o autenticador antes de confirmar sua identidade.</p>
            </div>
          )}
        </section>
      </div>
      <Dialog open={confirmDisable} onOpenChange={setConfirmDisable}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Desativar autenticação em duas etapas?</DialogTitle>
            <DialogDescription>
              O próximo acesso usará apenas sua senha. Ações sensíveis ficam bloqueadas até
              configurar um segundo fator novamente.
            </DialogDescription>
          </DialogHeader>
          <SecurityForm
            password
            submit="Desativar proteção"
            onSubmit={async (values) => {
              setBusy(true);
              try {
                await api('/api/auth/two-factor/disable', resultSchema, {
                  password: values.password,
                });
                setCodes(null);
                setProofUntil(0);
                setConfirmDisable(false);
                await refresh();
                toast.success('Autenticação em duas etapas desativada.');
              } finally {
                setBusy(false);
              }
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDisable(false)}>
              Cancelar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

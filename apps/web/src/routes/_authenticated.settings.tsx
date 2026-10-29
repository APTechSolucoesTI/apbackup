import { createFileRoute, Link } from '@tanstack/react-router';
import { Route as ProtectedRoute } from './_authenticated';
import { humanLabel } from '@/lib/listing';
import { Button } from '@/components/ui/button';
export const Route = createFileRoute('/_authenticated/settings')({ component: Settings });
function Settings() {
  const { identity } = ProtectedRoute.useRouteContext();
  if (identity.status !== 'ok') return null;
  const session = identity.session;
  return (
    <>
      <div className="page-eyebrow">ORGANIZAÇÃO / CONFIGURAÇÕES</div>
      <div className="page-header">
        <div>
          <h1>Configurações</h1>
          <p>Contexto da organização e do acesso atual.</p>
        </div>
      </div>
      <section className="settings-card">
        <h2>Organização atual</h2>
        <dl className="settings-details">
          <dt>Organização</dt>
          <dd>{session.organization}</dd>
          <dt>Conta</dt>
          <dd>{session.email}</dd>
          <dt>Papel</dt>
          <dd>{humanLabel(session.role)}</dd>
          <dt>Identificador da organização</dt>
          <dd className="font-mono">{session.organizationId}</dd>
        </dl>
        <Button asChild variant="outline">
          <Link to="/security">Gerenciar segurança da conta</Link>
        </Button>
      </section>
      <p className="catalog-footnote">
        As configurações operacionais são gerenciadas nos respectivos módulos. Nenhuma agenda é
        ativada ao abrir o console.
      </p>
    </>
  );
}

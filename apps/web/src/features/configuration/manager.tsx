import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Eye, Pencil, Archive, ArchiveRestore, Ellipsis, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { configurationKindSchema } from '@apbackup/contracts';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { DataState } from '@/components/data-state';
import type { ConsoleSession } from '@/lib/client-api';
import type { CatalogKind, CatalogRow } from '@/lib/listing';
import { ConfigurationForm } from './form';
import { configurationRequest, ConfigurationRequestError, readSchemas, entityCopy } from './client';
type Action = { mode: 'create' | 'view' | 'edit' | 'archive' | 'restore'; id?: string };
export function useConfigurationManager(catalogKind: CatalogKind, session: ConsoleSession | null) {
  const parsed = configurationKindSchema.safeParse(catalogKind),
    kind = parsed.success ? parsed.data : 'servers';
  const [action, setAction] = useState<Action | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const cache = useQueryClient(),
    copy = entityCopy[kind],
    scope = `${session?.userId}:${session?.organizationId}`;
  const query = useQuery({
    queryKey: ['configuration-record', scope, kind, action?.id],
    enabled: Boolean(parsed.success && action?.id),
    queryFn: ({ signal }) =>
      configurationRequest(`${kind}/${action!.id}`, readSchemas[kind], undefined, signal),
    staleTime: 0,
  });
  const open = (next: Action) => {
    if (next.id) cache.removeQueries({ queryKey: ['configuration-record', scope, kind, next.id] });
    setError('');
    setAction(next);
  };
  const saved = async () => {
    await Promise.all([
      cache.invalidateQueries({ queryKey: ['catalog', session?.userId, session?.organizationId] }),
      cache.invalidateQueries({ queryKey: ['configuration-options', scope] }),
    ]);
    setAction(null);
    toast.success('Cadastro atualizado.');
  };
  const rowActions = parsed.success
    ? (row: CatalogRow) => (
        <>
          <div className="desktop-row-actions">
            <Button
              variant="ghost"
              size="icon-sm"
              title={`Visualizar ${row.name}`}
              aria-label={`Visualizar ${row.name}`}
              onClick={() => open({ mode: 'view', id: row.id })}
            >
              <Eye />
            </Button>
            {session?.canConfigure && (
              <>
                {row.status !== 'arquivado' && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title={`Editar ${row.name}`}
                    aria-label={`Editar ${row.name}`}
                    onClick={() => open({ mode: 'edit', id: row.id })}
                  >
                    <Pencil />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title={`${row.status === 'arquivado' ? 'Restaurar' : 'Arquivar'} ${row.name}`}
                  aria-label={`${row.status === 'arquivado' ? 'Restaurar' : 'Arquivar'} ${row.name}`}
                  onClick={() =>
                    open({ mode: row.status === 'arquivado' ? 'restore' : 'archive', id: row.id })
                  }
                >
                  {row.status === 'arquivado' ? <ArchiveRestore /> : <Archive />}
                </Button>
              </>
            )}
          </div>
          <div className="mobile-row-actions">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={`Mais ações: ${row.name}`}>
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => open({ mode: 'view', id: row.id })}>
                  <Eye />
                  Visualizar
                </DropdownMenuItem>
                {session?.canConfigure && (
                  <>
                    {row.status !== 'arquivado' && (
                      <DropdownMenuItem onSelect={() => open({ mode: 'edit', id: row.id })}>
                        <Pencil />
                        Editar
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() =>
                        open({
                          mode: row.status === 'arquivado' ? 'restore' : 'archive',
                          id: row.id,
                        })
                      }
                    >
                      {row.status === 'arquivado' ? <ArchiveRestore /> : <Archive />}
                      {row.status === 'arquivado' ? 'Restaurar cadastro' : 'Arquivar cadastro'}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </>
      )
    : undefined;
  const primary =
    parsed.success && session?.role === 'administrator' ? (
      session.canConfigure ? (
        <Button onClick={() => open({ mode: 'create' })}>
          <Plus aria-hidden="true" />
          {copy.create}
        </Button>
      ) : (
        <Button asChild variant="outline">
          <Link to="/security">Confirmar identidade para configurar</Link>
        </Button>
      )
    ) : null;
  const dialog = parsed.success && (
    <Dialog
      open={Boolean(action)}
      onOpenChange={(value) => {
        if (!value && !busy) setAction(null);
      }}
    >
      <DialogContent className="configuration-dialog">
        <DialogHeader>
          <DialogTitle>
            {action?.mode === 'create'
              ? copy.create
              : action?.mode === 'archive'
                ? `Arquivar ${copy.singular}?`
                : action?.mode === 'restore'
                  ? `Restaurar ${copy.singular}?`
                  : action?.mode === 'view'
                    ? `Detalhes d${copy.article} ${copy.singular}`
                    : `Editar ${copy.singular}`}
          </DialogTitle>
          <DialogDescription>
            {action?.mode === 'archive'
              ? 'O cadastro sai das listagens ativas. O histórico e as evidências são preservados.'
              : action?.mode === 'restore'
                ? 'O cadastro volta às listagens. Planos e destinos retornam desabilitados.'
                : 'Cadastros são isolados por organização e não executam operações externas ao salvar.'}
          </DialogDescription>
        </DialogHeader>
        {action?.id && query.isPending ? (
          <DataState state="loading" />
        ) : action?.id && query.isError ? (
          <DataState
            state={
              query.error instanceof ConfigurationRequestError
                ? query.error.status === 404
                  ? 'missing'
                  : query.error.status === 403
                    ? 'forbidden'
                    : 'error'
                : 'error'
            }
            onRetry={() => void query.refetch()}
          />
        ) : action && (action.mode === 'archive' || action.mode === 'restore') ? (
          <div className="archive-confirmation">
            <p>
              <strong>{query.data?.name}</strong>
            </p>
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            <div className="configuration-form-footer">
              <Button variant="outline" disabled={busy} onClick={() => setAction(null)}>
                Cancelar
              </Button>
              <Button
                disabled={busy || !query.data}
                onClick={async () => {
                  if (!query.data || !action.id) return;
                  setBusy(true);
                  setError('');
                  try {
                    await configurationRequest(
                      `${kind}/${action.id}/${action.mode}`,
                      readSchemas[kind],
                      { expectedUpdatedAt: query.data.updatedAt },
                    );
                    await saved();
                  } catch (cause) {
                    setError(
                      cause instanceof ConfigurationRequestError
                        ? cause.message
                        : 'Não foi possível concluir. Tente novamente.',
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy
                  ? 'Salvando…'
                  : action.mode === 'archive'
                    ? 'Confirmar arquivamento'
                    : 'Restaurar cadastro'}
              </Button>
            </div>
          </div>
        ) : (
          action && (
            <ConfigurationForm
              key={`${kind}:${action.mode}:${action.id ?? 'new'}`}
              kind={kind}
              {...(action.id && query.data ? { record: query.data } : {})}
              readOnly={action.mode === 'view'}
              cacheScope={scope}
              onSaved={saved}
              onCancel={() => setAction(null)}
              onPendingChange={setBusy}
            />
          )
        )}
      </DialogContent>
    </Dialog>
  );
  return { primary, rowActions, dialog };
}

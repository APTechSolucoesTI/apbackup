import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { z } from 'zod';
import {
  Folder,
  ChevronDown,
  ChevronRight,
  Database,
  Files,
  Boxes,
  Play,
  Settings2,
  Search,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  backupSystemsOverviewSchema,
  backupSystemComponentSchema,
  backupSystemSchema,
  systemBackupResultSchema,
} from '@apbackup/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { DataState } from '@/components/data-state';
import { CatalogPage } from '@/components/catalog-page';
import { api, HttpError } from '@/lib/client-api';
import { humanLabel } from '@/lib/listing';
import { Route as ProtectedRoute } from '@/routes/_authenticated';
import { SystemEditor } from './editor';
type System = z.infer<typeof backupSystemSchema>;
type Component = z.infer<typeof backupSystemComponentSchema>;
const kindLabels = { application: 'Aplicação', database: 'Banco de dados', files: 'Arquivos' };
function date(value: string) {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}
function result(d: Component['destinations'][number]) {
  return d.removedAt
    ? 'Removido pela retenção'
    : d.retentionPending
      ? 'Retenção em andamento'
      : d.status === 'concluida' && d.verifiedAt
        ? 'Verificado'
        : d.status
          ? humanLabel(d.status)
          : 'Sem resultado';
}
function ComponentDetail({ component: c, serverId }: { component: Component; serverId: string }) {
  const Icon = c.kind === 'database' ? Database : c.kind === 'files' ? Files : Boxes;
  const route =
    c.adapter === 'postgresql' ? '/postgresql' : c.adapter === 'docker-resource' ? '/docker' : null;
  return (
    <section className="space-y-3 border-t p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Icon className="h-4 w-4" aria-hidden />
            {kindLabels[c.kind]}
            {c.shared && <Badge variant="outline">Compartilhado</Badge>}
          </p>
          <h3 className="mt-1 break-words text-base font-semibold">{c.label}</h3>
          <p className="mt-1 break-words text-xs text-muted-foreground">
            Plano: {c.planName} · {c.enabled ? 'Ativo' : 'Desativado'}
          </p>
        </div>
        <Badge
          variant="outline"
          className={`status-badge status-${c.latest?.status ?? 'cadastrado'}`}
        >
          {c.latest ? humanLabel(c.latest.status) : 'Ainda sem execução'}
        </Badge>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
        <span>
          {c.schedules.length
            ? c.schedules.map((s, i) => (
                <span key={i} className="mr-3">
                  {s.enabled ? 'Diário' : 'Agenda desativada'} · {s.time.slice(0, 5)} · {s.timezone}
                </span>
              ))
            : 'Sem agenda cadastrada'}
        </span>
        <span>
          {c.retentionDays ? `Retenção de ${c.retentionDays} dias` : 'Sem retenção definida'}
        </span>
        {c.latest && <span>Última execução: {date(c.latest.createdAt)}</span>}
      </div>
      {c.scopeNote && <p className="rounded-md bg-muted p-3 text-sm">{c.scopeNote}</p>}
      <div className="flex flex-wrap gap-2" aria-label="Resultados por destino">
        {c.destinations.length ? (
          c.destinations.map((d) => (
            <span key={d.repositoryId} className="rounded-md border px-3 py-2 text-xs">
              <strong className="font-semibold">{d.name}</strong> · {result(d)}
              {d.verifiedAt && (
                <span className="block pt-1 text-muted-foreground">{date(d.verifiedAt)}</span>
              )}
            </span>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">Nenhum destino vinculado a este plano.</p>
        )}
      </div>
      <details className="rounded-md border">
        <summary className="cursor-pointer px-3 py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
          Pontos de recuperação recentes
        </summary>
        <div className="space-y-3 border-t p-3">
          {!c.points.length ? (
            <p className="text-sm text-muted-foreground">
              Nenhum ponto registrado para este plano.
            </p>
          ) : (
            c.points.map((p) => (
              <div key={p.id} className="space-y-1 text-xs">
                <div className="flex flex-wrap justify-between gap-2">
                  <strong>{date(p.capturedAt)}</strong>
                  <span>{p.status === 'complete' ? 'Captura completa' : humanLabel(p.status)}</span>
                </div>
                <p className="break-all font-mono text-muted-foreground">{p.id}</p>
                {p.destinations.map((d) => (
                  <p key={d.repositoryId}>
                    {d.name}: {result(d)}
                  </p>
                ))}
              </div>
            ))
          )}
          {route && (
            <Link
              to={route}
              search={{
                ...(c.profileVersionId ? { profileVersionId: c.profileVersionId } : {}),
                serverId,
              }}
              className="inline-flex min-h-11 items-center text-sm font-medium text-primary"
            >
              Abrir recuperação de {c.kind === 'database' ? 'banco' : 'aplicação / arquivos'}
            </Link>
          )}
          <p className="text-xs text-muted-foreground">
            Selecione o ponto deste componente na tela de recuperação. Retornos exigem senha e
            segundo fator. Componentes compartilhados podem afetar outros sistemas.
          </p>
        </div>
      </details>
    </section>
  );
}
function SystemFolder({
  system,
  canBackup,
  canConfigure,
  onEdit,
}: {
  system: System;
  canBackup: boolean;
  canConfigure: boolean;
  onEdit: () => void;
}) {
  const [expanded, setExpanded] = useState(false),
    cache = useQueryClient();
  const requestKey = useRef<string | null>(null);
  const run = useMutation({
    mutationFn: () => {
      requestKey.current ??= crypto.randomUUID();
      return api(`/api/systems/${system.id}/backup`, systemBackupResultSchema, {
        idempotencyKey: requestKey.current,
      });
    },
    onSuccess: (data) => {
      requestKey.current = null;
      toast.success(`${data.executions.length} plano(s) colocado(s) na fila.`);
      void cache.invalidateQueries({ queryKey: ['systems'] });
    },
  });
  return (
    <article className="overflow-hidden rounded-lg border bg-card text-card-foreground shadow-card">
      <div className="flex flex-wrap items-center gap-3 p-4 sm:p-5">
        <button
          type="button"
          className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-2 focus-visible:outline-ring"
          aria-expanded={expanded}
          aria-controls={`system-${system.id}`}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4 shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0" />
          )}
          <Folder className="h-6 w-6 shrink-0 text-primary" aria-hidden />
          <span className="min-w-0">
            <span className="block break-words text-lg font-semibold">{system.name}</span>
            <span className="mt-1 block text-xs text-muted-foreground">
              {system.serverName} · {system.components.length} componente(s)
            </span>
          </span>
        </button>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          {canConfigure && (
            <Button variant="outline" onClick={onEdit}>
              <Settings2 aria-hidden />
              Configurar
            </Button>
          )}
          {canBackup && (
            <Button
              disabled={
                run.isPending ||
                !system.components.length ||
                system.components.some((c) => !c.enabled)
              }
              onClick={() => run.mutate()}
            >
              <Play aria-hidden />
              {run.isPending ? 'Solicitando…' : 'Backup agora'}
            </Button>
          )}
        </div>
      </div>
      {system.description && (
        <p className="px-5 pb-4 text-sm text-muted-foreground">{system.description}</p>
      )}
      {!expanded && system.components.length > 0 && (
        <div className="flex flex-wrap gap-2 px-5 pb-4">
          {system.components.map((c) => (
            <Badge
              key={`${c.planId}:${c.kind}`}
              variant="outline"
              className={`status-badge status-${c.latest?.status ?? 'cadastrado'}`}
            >
              {kindLabels[c.kind]} · {c.latest ? humanLabel(c.latest.status) : 'Sem execução'}
            </Badge>
          ))}
        </div>
      )}
      {run.isError && (
        <p role="alert" className="px-5 pb-4 text-sm text-destructive">
          Não foi possível confirmar a solicitação. Verifique os planos e tente novamente; a mesma
          tentativa não duplica execuções.
        </p>
      )}
      {expanded && (
        <div id={`system-${system.id}`}>
          <div className="border-t bg-muted/40 p-4 sm:p-5">
            <h2 className="text-sm font-semibold">Escopo de proteção</h2>
            <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">
              {system.scopeNotes ||
                'Confira os componentes vinculados e suas dependências antes de recuperar.'}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Backup agora executa uma vez cada plano vinculado neste sistema. Aplicação, bancos e
              arquivos têm pontos de recuperação independentes.
            </p>
          </div>
          {system.components.length ? (
            system.components.map((c) => (
              <ComponentDetail
                key={`${c.planId}:${c.kind}`}
                component={c}
                serverId={system.serverId}
              />
            ))
          ) : (
            <DataState
              state="empty"
              title="Nenhum componente vinculado"
              description="Configure o sistema e vincule planos existentes deste servidor."
            />
          )}
        </div>
      )}
    </article>
  );
}
export function SystemsPage() {
  const identity = ProtectedRoute.useRouteContext().identity,
    session = identity.status === 'ok' ? identity.session : null;
  const [search, setSearch] = useState(''),
    [advanced, setAdvanced] = useState(false),
    [editor, setEditor] = useState<System | null | undefined>(undefined);
  const query = useQuery({
    queryKey: ['systems', 'overview', session?.organizationId],
    queryFn: ({ signal }) =>
      api('/api/systems/overview', backupSystemsOverviewSchema, undefined, signal),
    refetchInterval: 5000,
  });
  const canConfigure = session?.canConfigure ?? false,
    canBackup = session?.role === 'administrator' || session?.role === 'backup_operator';
  if (advanced)
    return (
      <div className="space-y-4">
        <Button variant="outline" onClick={() => setAdvanced(false)}>
          Voltar aos sistemas
        </Button>
        <CatalogPage kind="systems" />
      </div>
    );
  const filtered =
    query.data?.items.filter((s) =>
      `${s.name} ${s.description} ${s.serverName}`
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLocaleLowerCase('pt-BR')
        .includes(
          search
            .normalize('NFD')
            .replace(/\p{Diacritic}/gu, '')
            .toLocaleLowerCase('pt-BR'),
        ),
    ) ?? [];
  return (
    <div className="space-y-6">
      <header className="page-heading">
        <div>
          <p className="text-xs font-semibold text-muted-foreground">PROTEÇÃO POR APLICAÇÃO</p>
          <h1>Sistemas</h1>
          <p className="text-muted-foreground">
            Aplicações, bancos e arquivos organizados por sistema, com os resultados de cada
            destino.
          </p>
        </div>
        {canConfigure && <Button onClick={() => setEditor(null)}>Novo sistema</Button>}
      </header>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full sm:max-w-sm">
          <label htmlFor="system-search" className="sr-only">
            Buscar nome ou servidor
          </label>
          <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden />
          <Input
            id="system-search"
            className="pl-9"
            placeholder="Buscar nome ou servidor…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button variant="ghost" onClick={() => setAdvanced(true)}>
          Catálogo avançado de perfis
        </Button>
      </div>
      {query.isPending ? (
        <DataState state="loading" />
      ) : query.isError ? (
        <DataState
          state={
            query.error instanceof HttpError && query.error.status === 403 ? 'forbidden' : 'error'
          }
          onRetry={() => void query.refetch()}
        />
      ) : !query.data.items.length ? (
        <DataState
          state="empty"
          title="Organize a proteção dos seus sistemas"
          description="Crie um sistema e vincule os planos reais de aplicação, bancos e arquivos. Nenhum backup é ativado ao criar a pasta."
        />
      ) : !filtered.length ? (
        <DataState state="no-results" onClear={() => setSearch('')} />
      ) : (
        <div className="space-y-4">
          {filtered.map((s) => (
            <SystemFolder
              key={s.id}
              system={s}
              canBackup={canBackup}
              canConfigure={canConfigure}
              onEdit={() => setEditor(s)}
            />
          ))}
        </div>
      )}
      {editor !== undefined && (
        <SystemEditor system={editor} onClose={() => setEditor(undefined)} />
      )}
    </div>
  );
}

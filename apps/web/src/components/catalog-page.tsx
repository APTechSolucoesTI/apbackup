import { useEffect, useState } from 'react';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ShieldAlert, Search, X, RefreshCw, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfigurableTable, Pagination } from './configurable-table';
import {
  ColumnSettingsDialog,
  type ColumnPreference,
  type TableColumn,
} from './column-settings-dialog';
import { DataState } from './data-state';
import { api, HttpError } from '@/lib/client-api';
import {
  humanLabel,
  listQuerySchema,
  listResultSchema,
  type CatalogKind,
  type CatalogRow,
  type ListQuery,
} from '@/lib/listing';
import { Route as ProtectedRoute } from '@/routes/_authenticated';
import { useConfigurationManager } from '@/features/configuration/manager';
const copy: Record<
  CatalogKind,
  { title: string; description: string; empty: string; emptyDescription: string }
> = {
  coverage: {
    title: 'Cobertura',
    description: 'Pontos de recuperação registrados no catálogo da sua organização.',
    empty: 'Nenhum ponto de recuperação registrado',
    emptyDescription:
      'A cobertura começa com uma captura completa, verificação por destino e evidências do escopo protegido.',
  },
  servers: {
    title: 'Servidores',
    description: 'Origens cadastradas para descoberta e proteção de recursos.',
    empty: 'Nenhum servidor cadastrado',
    emptyDescription: 'Cadastre uma origem para organizar seus recursos e preparar a proteção.',
  },
  systems: {
    title: 'Sistemas',
    description: 'Perfis que agrupam recursos e dependências de cada aplicação.',
    empty: 'Nenhum sistema cadastrado',
    emptyDescription:
      'Os perfis de sistema agrupam bancos, arquivos e serviços com suas dependências.',
  },
  resources: {
    title: 'Recursos',
    description: 'Bancos, arquivos, serviços e máquinas virtuais identificados por origem.',
    empty: 'Nenhum recurso cadastrado',
    emptyDescription: 'Recursos de aplicação e máquinas virtuais aparecem separadamente por tipo.',
  },
  destinations: {
    title: 'Destinos',
    description: 'Locais de armazenamento e seu estado real de configuração.',
    empty: 'Nenhum destino cadastrado',
    emptyDescription:
      'Um destino só recebe dados após ter protocolo, pasta dedicada e credenciais configurados.',
  },
  plans: {
    title: 'Planos',
    description: 'Escopo, retenção e agendamento dos planos cadastrados.',
    empty: 'Nenhum plano cadastrado',
    emptyDescription:
      'Nenhuma agenda é ativada automaticamente. Os planos cadastrados aparecerão aqui.',
  },
  executions: {
    title: 'Execuções',
    description: 'Histórico persistente das operações e seus estados.',
    empty: 'Nenhuma execução registrada',
    emptyDescription:
      'As operações de backup, verificação e restauração serão registradas aqui quando forem executadas.',
  },
};
const statuses: Partial<Record<CatalogKind, string[]>> = {
  servers: ['cadastrado', 'arquivado'],
  systems: ['cadastrado', 'arquivado'],
  destinations: ['aguardando_configuracao', 'ativo', 'indisponivel', 'desabilitado', 'arquivado'],
  plans: ['habilitado', 'desabilitado', 'arquivado'],
  resources: [
    'postgresql',
    'files',
    'compose',
    'swarm',
    'dokploy',
    'redis',
    'supabase_schema',
    'supabase_auth',
    'supabase_storage',
    'vm',
    'proxmox_host',
    'pbs_configuration',
    'arquivado',
  ],
  executions: [
    'aguardando',
    'verificando',
    'capturando',
    'enviando',
    'verificando_destino',
    'concluida',
    'falhas_parciais',
    'falhou',
    'cancelada',
    'exige_intervencao',
  ],
  coverage: ['incomplete', 'complete', 'quarantined', 'expired'],
};
export function CatalogPage({ kind }: { kind: CatalogKind }) {
  const { identity } = ProtectedRoute.useRouteContext();
  const navigate = useNavigate();
  const search = useRouterState({ select: (s) => s.location.search });
  const q = listQuerySchema.parse({ ...search, kind });
  const [text, setText] = useState(q.search),
    [preference, setPreference] = useState<ColumnPreference>({
      keys: ['name', 'detail', 'status', 'createdAt'],
      pageSize: q.pageSize,
    });
  const user = identity.status === 'ok' ? identity.session : null;
  const configuration = useConfigurationManager(kind, user);
  const storageKey = `apbackup:columns:${user?.userId}:${user?.organizationId}:${kind}`;
  const update = (change: Partial<ListQuery>, replace = false) => {
    const next = { ...q, ...change };
    if (kind === 'coverage') void navigate({ to: '/', search: next, replace });
    else void navigate({ to: '/$section', params: { section: kind }, search: next, replace });
  };
  useEffect(() => {
    setText(q.search);
  }, [q.search, kind]);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (text !== q.search) update({ search: text, page: 1 }, true);
    }, 350);
    return () => clearTimeout(timer);
  }, [text, q.search]); // Query changes are issued only for the current input.
  useEffect(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as unknown;
      if (raw && typeof raw === 'object' && 'keys' in raw && Array.isArray(raw.keys)) {
        const keys = raw.keys.filter(
          (k): k is string =>
            typeof k === 'string' && ['name', 'detail', 'status', 'createdAt'].includes(k),
        );
        if (!keys.includes('name')) keys.unshift('name');
        const savedSize =
          'pageSize' in raw ? listQuerySchema.shape.pageSize.safeParse(raw.pageSize) : null;
        const pageSize = savedSize?.success ? savedSize.data : q.pageSize;
        setPreference({ keys, pageSize });
        if (!new URLSearchParams(window.location.search).has('pageSize') && pageSize !== q.pageSize)
          update({ pageSize, page: 1 }, true);
      } else
        setPreference({ keys: ['name', 'detail', 'status', 'createdAt'], pageSize: q.pageSize });
    } catch {
      setPreference({ keys: ['name', 'detail', 'status', 'createdAt'], pageSize: q.pageSize });
    }
  }, [storageKey]);
  const query = useQuery({
    queryKey: ['catalog', user?.userId, user?.organizationId, kind, q],
    queryFn: ({ signal }) =>
      api(
        `/api/console/catalog?${new URLSearchParams(Object.entries(q).map(([key, value]) => [key, String(value)]))}`,
        listResultSchema,
        undefined,
        signal,
      ),
    placeholderData: keepPreviousData,
  });
  useEffect(() => {
    if (query.data && query.data.page !== q.page && !query.isPlaceholderData)
      update({ page: query.data.page }, true);
  }, [query.data?.page, query.isPlaceholderData, q.page]);
  const meta = copy[kind];
  const columns: TableColumn<CatalogRow>[] = [
    {
      key: 'name',
      label: kind === 'coverage' || kind === 'executions' ? 'Identificador' : 'Nome',
      identifier: true,
      mono: kind === 'coverage' || kind === 'executions',
    },
    {
      key: 'detail',
      label: kind === 'executions' ? 'Operação' : 'Identificação',
      mono: kind !== 'executions',
    },
    { key: 'status', label: kind === 'resources' ? 'Tipo' : 'Estado' },
    { key: 'createdAt', label: 'Cadastrado em' },
  ];
  const visible = preference.keys
    .map((key) => columns.find((c) => c.key === key))
    .filter((col): col is TableColumn<CatalogRow> => Boolean(col));
  const active = (q.search ? 1 : 0) + (q.status ? 1 : 0);
  const clear = () => {
    setText('');
    update({ search: '', status: '', page: 1 });
  };
  return (
    <>
      <div className="page-eyebrow">OPERAÇÃO / {meta.title.toLocaleUpperCase('pt-BR')}</div>
      <div className="page-header">
        <div>
          <h1>{meta.title}</h1>
          <p>{meta.description}</p>
        </div>
        {kind === 'coverage' && (
          <Button asChild>
            <Link to="/$section" params={{ section: 'destinations' }} search={{}}>
              Ver destinos
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        )}
        {configuration.primary}
      </div>
      {kind === 'coverage' && (
        <section className="coverage-notice" aria-label="Critérios de cobertura">
          <ShieldAlert aria-hidden="true" />
          <div>
            <h2>Proteção exige evidência</h2>
            <p>
              Um cadastro ou envio de arquivo não comprova recuperação. Consulte a verificação
              individual por ponto, destino e escopo antes de considerar um sistema protegido.
            </p>
          </div>
        </section>
      )}
      <section
        className="catalog-panel"
        aria-label={`Listagem de ${meta.title.toLocaleLowerCase('pt-BR')}`}
      >
        <div className="list-toolbar">
          <div className="search-field">
            <Search aria-hidden="true" />
            <label className="sr-only" htmlFor={`search-${kind}`}>
              Buscar nome ou identificação
            </label>
            <Input
              id={`search-${kind}`}
              placeholder="Buscar nome ou identificação…"
              value={text}
              disabled={query.isPending}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setText('');
                  update({ search: '', page: 1 });
                }
              }}
            />
            {text && (
              <button
                aria-label="Limpar busca"
                onClick={() => {
                  setText('');
                  update({ search: '', page: 1 });
                }}
              >
                <X />
              </button>
            )}
          </div>
          {statuses[kind] && (
            <label className="filter-field">
              <span className="sr-only">
                {kind === 'resources' ? 'Filtrar tipo' : 'Filtrar estado'}
              </span>
              <select
                className="native-select"
                value={q.status}
                disabled={query.isPending}
                onChange={(e) => update({ status: e.target.value, page: 1 })}
              >
                <option value="">{kind === 'resources' ? 'Tipo: todos' : 'Estado: todos'}</option>
                {statuses[kind]?.map((value) => (
                  <option key={value} value={value}>
                    {humanLabel(value)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="toolbar-actions">
            {active > 0 && (
              <Button variant="ghost" size="sm" onClick={clear}>
                Limpar filtros ({active})
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              aria-label="Atualizar listagem"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              <RefreshCw className={query.isFetching ? 'animate-spin' : ''} />
            </Button>
            <ColumnSettingsDialog
              columns={columns}
              value={{ ...preference, pageSize: q.pageSize }}
              onApply={(value) => {
                setPreference(value);
                try {
                  localStorage.setItem(storageKey, JSON.stringify(value));
                } catch {
                  /* URL and current view still work. */
                }
                update({ pageSize: value.pageSize, page: 1 });
              }}
            />
          </div>
        </div>
        {query.isFetching && !query.isPending && (
          <div className="refresh-status" role="status">
            Atualizando catálogo…
          </div>
        )}
        {query.data && <Pagination data={query.data} onPage={(page) => update({ page })} />}
        <div className="table-region" aria-busy={query.isFetching}>
          {query.isPending ? (
            <>
              <div className="table-skeleton" aria-hidden="true">
                {[1, 2, 3, 4].map((n) => (
                  <Skeleton key={n} className="h-8 w-full" />
                ))}
              </div>
              <DataState state="loading" />
            </>
          ) : query.isError ? (
            <DataState
              state={
                query.error instanceof HttpError && query.error.status === 403
                  ? 'forbidden'
                  : 'error'
              }
              onRetry={() => void query.refetch()}
            />
          ) : (
            <>
              <ConfigurableTable
                {...(configuration.rowActions ? { actions: configuration.rowActions } : {})}
                items={query.data.items}
                columns={visible}
                sort={q.sort}
                direction={q.direction}
                onSort={(key) =>
                  update({
                    sort: listQuerySchema.shape.sort.parse(key),
                    direction:
                      q.sort === key
                        ? q.direction === 'none'
                          ? 'asc'
                          : q.direction === 'asc'
                            ? 'desc'
                            : 'none'
                        : 'asc',
                    page: 1,
                  })
                }
              />
              {query.data.total === 0 && (
                <DataState
                  state={active ? 'no-results' : 'empty'}
                  {...(active
                    ? { onClear: clear }
                    : { title: meta.empty, description: meta.emptyDescription })}
                />
              )}
            </>
          )}
        </div>
        {query.data && query.data.total > 10 && (
          <Pagination data={query.data} onPage={(page) => update({ page })} />
        )}
      </section>
      <p className="catalog-footnote">
        Somente dados da organização atual. Configurações cadastradas não representam cobertura
        verificada.
      </p>
      {configuration.dialog}
    </>
  );
}

import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from '@tanstack/react-router';
import { z } from 'zod';
import { RefreshCw, Play, ArchiveRestore, Search, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import {
  dockerCatalogSchema,
  dockerSelectionSchema,
  dockerEvidenceSchema,
  dockerRestoreInputSchema,
  dockerRestoredSchema,
  postgresPlanSchema,
  optionsResultSchema,
} from '@apbackup/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { DataState } from '@/components/data-state';
import { Route as ProtectedRoute } from '@/routes/_authenticated';
import { api } from '@/lib/client-api';
import { humanLabel } from '@/lib/listing';
import { configurationRequest } from '@/features/configuration/client';
import {
  AdditionalDestinations,
  PointDestinationStatus,
  RestoreRepository,
} from '@/features/destinations/operations';
const overviewSchema = z.object({
  plans: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      selection: dockerSelectionSchema,
      latest: z.object({ id: z.uuid(), status: z.string() }).nullable(),
    }),
  ),
  points: z.array(
    z.object({
      id: z.uuid(),
      selection: dockerSelectionSchema,
      capturedAt: z.string(),
      evidence: dockerEvidenceSchema,
    }),
  ),
  restores: z.array(
    z.object({
      id: z.uuid(),
      targetName: z.string(),
      status: z.string(),
      evidence: dockerRestoredSchema.nullable(),
    }),
  ),
});
type Point = z.infer<typeof overviewSchema>['points'][number];
async function request<T>(path: string, schema: z.ZodType<T>, value?: unknown) {
  return api('/api/docker/' + path, schema, value);
}
const selectedSchema = z.object({ profileVersionId: z.uuid(), resourceId: z.uuid() }),
  idSchema = z.object({ id: z.uuid() }),
  executionSchema = z.object({ executionId: z.uuid() });
const kinds = {
  container: 'Aplicação / container',
  volume: 'Volume nomeado',
  directory: 'Diretório aprovado',
  swarm: 'Aplicação Swarm (grupo de serviços)',
};
type SwarmRole = 'frontend' | 'api' | 'worker';
export function DockerPage() {
  const identity = ProtectedRoute.useRouteContext().identity,
    role = identity.status === 'ok' ? identity.session.role : 'viewer',
    canConfigure = identity.status === 'ok' && identity.session.canConfigure,
    canBackup = ['administrator', 'backup_operator'].includes(role),
    canRestore = ['administrator', 'restore_operator'].includes(role);
  const cache = useQueryClient(),
    refresh = () => cache.invalidateQueries({ queryKey: ['docker'] });
  const [serverId, setServerId] = useState(''),
    [kind, setKind] = useState<'container' | 'volume' | 'directory' | 'swarm'>('container'),
    [swarmName, setSwarmName] = useState('aplicacao'),
    [swarmMembers, setSwarmMembers] = useState<
      Record<
        string,
        { role: SwarmRole; preserveEnvironmentKeys: string[]; startupReviewed: boolean }
      >
    >({}),
    [search, setSearch] = useState(''),
    [page, setPage] = useState(1),
    [pointPage, setPointPage] = useState(1),
    [selected, setSelected] = useState<{ profileVersionId: string; identity: string } | null>(null),
    [restorePoint, setRestorePoint] = useState<Point | null>(null);
  const [restoreAvailable, setRestoreAvailable] = useState(false);
  const restoreTrigger = useRef<HTMLButtonElement | null>(null);
  const servers = useQuery({
    queryKey: ['docker', 'servers'],
    queryFn: () => configurationRequest('options?kind=servers', optionsResultSchema),
  });
  const destinations = useQuery({
    queryKey: ['docker', 'destinations'],
    queryFn: () => configurationRequest('options?kind=destinations', optionsResultSchema),
    enabled: canConfigure,
  });
  const catalog = useQuery({
    queryKey: ['docker', 'catalog', serverId],
    queryFn: () => request(`catalog?serverId=${serverId}`, dockerCatalogSchema),
    enabled: !!serverId,
    refetchInterval: 30000,
  });
  const overview = useQuery({
    queryKey: ['docker', 'overview'],
    queryFn: () => request('overview', overviewSchema),
    refetchInterval: 3000,
  });
  const planForm = useForm<
    z.input<typeof postgresPlanSchema>,
    unknown,
    z.output<typeof postgresPlanSchema>
  >({
    resolver: zodResolver(postgresPlanSchema),
    defaultValues: {
      profileVersionId: '',
      destinationId: '',
      destinationIds: [],
      name: '',
      scheduleEnabled: false,
      localTime: '03:00',
      timezone: 'America/Sao_Paulo',
    },
  });
  const restoreForm = useForm<
    z.input<typeof dockerRestoreInputSchema>,
    unknown,
    z.output<typeof dockerRestoreInputSchema>
  >({
    resolver: zodResolver(dockerRestoreInputSchema),
    defaultValues: {
      recoveryPointId: '',
      targetName: '',
      replaceContainer: false,
      confirmation: '',
      idempotencyKey: '',
    },
  });
  const select = useMutation({
    mutationFn: (name: string) =>
      request('select', selectedSchema, {
        serverId,
        kind,
        identity: name,
        ...(kind === 'swarm'
          ? { services: Object.entries(swarmMembers).map(([id, member]) => ({ id, ...member })) }
          : {}),
      }),
    onSuccess: (data, name) => {
      setSelected({ profileVersionId: data.profileVersionId, identity: name });
      planForm.setValue('profileVersionId', data.profileVersionId);
      planForm.setValue('name', `Backup ${name}`);
    },
  });
  const plan = useMutation({
    mutationFn: (v: z.output<typeof postgresPlanSchema>) => request('plans', idSchema, v),
    onSuccess: () => {
      setSelected(null);
      void refresh();
      toast.success('Plano criado. Execute o primeiro backup.');
    },
  });
  const backup = useMutation({
    mutationFn: (planId: string) =>
      api('/api/runtime/execute', executionSchema, { planId, idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => {
      void refresh();
      toast.success('Backup entrou na fila do agente.');
    },
  });
  const restore = useMutation({
    mutationFn: (v: z.output<typeof dockerRestoreInputSchema>) => {
      if (!restoreAvailable || !v.repositoryId)
        throw new Error('Escolha uma cópia verificada para restaurar.');
      return request('restore', executionSchema, v);
    },
    onSuccess: () => {
      setRestorePoint(null);
      void refresh();
      toast.success('Restauração entrou na fila do agente.');
    },
  });
  const error = [select.error, plan.error, backup.error, restore.error].find(Boolean);
  const records =
    (kind === 'container'
      ? catalog.data?.containers.map((c) => ({
          name: c.name,
          detail: `${c.imageReference} · ${c.mounts.length} mount(s) próprio(s)`,
          blocked: c.blockedReason,
        }))
      : kind === 'volume'
        ? catalog.data?.volumes.map((v) => ({
            name: v.name,
            detail: `${v.owners.length} container(s) utiliza(m) este volume. Sem propriedade exclusiva presumida.`,
            blocked: v.databaseHint ? 'Dados de banco: use o conector lógico.' : null,
          }))
        : kind === 'swarm'
          ? []
          : catalog.data?.directories.map((d) => ({
              name: d.name,
              detail: 'Raiz configurada no agente. O caminho do host não é exposto.',
              blocked: null,
            }))) ?? [];
  const filtered = records.filter((r) =>
      r.name.toLocaleLowerCase('pt-BR').includes(search.toLocaleLowerCase('pt-BR')),
    ),
    pages = Math.max(1, Math.ceil(filtered.length / 10));
  const openRestore = (point: Point) => {
    setRestoreAvailable(false);
    setRestorePoint(point);
    restore.reset();
    restoreForm.reset({
      recoveryPointId: point.id,
      targetName:
        point.selection.kind === 'container' || point.selection.kind === 'swarm'
          ? point.selection.identity
          : point.selection.identity + '-recuperado',
      replaceContainer: point.selection.kind === 'container' || point.selection.kind === 'swarm',
      confirmation: '',
      idempotencyKey: crypto.randomUUID(),
      redeployGuardConfirmed: false,
    });
  };
  return (
    <div className="space-y-6">
      <header className="page-heading">
        <div>
          <p className="text-xs font-semibold text-muted-foreground">PROTEÇÃO DE RECURSOS</p>
          <h1>Docker e arquivos</h1>
          <p className="text-muted-foreground">
            Volte o código e os arquivos da aplicação. Restaure o banco em uma ação independente.
          </p>
        </div>
        <Button variant="outline" onClick={() => void refresh()}>
          <RefreshCw aria-hidden="true" />
          Atualizar
        </Button>
      </header>
      <aside className="rounded-lg border bg-secondary p-4 text-secondary-foreground">
        <ShieldCheck className="mr-2 inline h-4 w-4" aria-hidden="true" />
        Captura de arquivos em uso: consistência de falha, sem pausa automática. Restic cifrado e
        componentes verificados. Destino local não protege contra perda do host.
      </aside>
      {error && (
        <p role="alert" className="rounded-md border border-destructive p-3 text-destructive">
          {error.message}
        </p>
      )}
      <section className="space-y-4 rounded-lg border bg-card p-4">
        <h2 className="text-xl font-semibold">1. Descobrir e selecionar</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="docker-server">Servidor com agente Docker</Label>
            <select
              id="docker-server"
              className="native-select w-full"
              value={serverId}
              onChange={(e) => {
                setServerId(e.target.value);
                setPage(1);
                setSelected(null);
                setSwarmMembers({});
              }}
            >
              <option value="">Selecione o servidor</option>
              {servers.data?.items.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="docker-kind">Tipo de recurso</Label>
            <select
              id="docker-kind"
              className="native-select w-full"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as typeof kind);
                setPage(1);
                setSelected(null);
                setSwarmMembers({});
              }}
            >
              {Object.entries(kinds).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>
        {servers.isError && <DataState state="error" onRetry={() => void servers.refetch()} />}
        {!serverId ? (
          <p className="text-muted-foreground">
            O agente autenticado atualiza containers, volumes, mounts e serviços sem alterar os
            serviços.
          </p>
        ) : catalog.isPending ? (
          <DataState state="loading" />
        ) : catalog.isError ? (
          <DataState
            state="error"
            title="Agente Docker indisponível"
            description="Confira a conexão e a configuração Docker do agente; depois atualize a descoberta."
            onRetry={() => void catalog.refetch()}
          />
        ) : (
          <>
            {kind === 'swarm' && (
              <fieldset className="space-y-3 rounded-md border p-3">
                <legend className="px-1 font-semibold">Grupo da aplicação</legend>
                <p className="text-sm text-muted-foreground">
                  Selecione até três serviços e confirme seus papéis. O banco e serviços de outras
                  aplicações ficam fora deste grupo.
                </p>
                <Label htmlFor="swarm-name">Nome do grupo</Label>
                <Input
                  id="swarm-name"
                  value={swarmName}
                  onChange={(e) => setSwarmName(e.target.value)}
                />
                {catalog.data?.services.map((service) => {
                  const member = swarmMembers[service.id];
                  return (
                    <div className="space-y-3 rounded-md border p-3" key={service.id}>
                      <Label className="flex items-center gap-2 break-all">
                        <input
                          type="checkbox"
                          checked={!!member}
                          disabled={
                            !canConfigure || (!member && Object.keys(swarmMembers).length >= 3)
                          }
                          onChange={(e) => {
                            setSelected(null);
                            setSwarmMembers((current) => {
                              const next = { ...current };
                              if (!e.target.checked) delete next[service.id];
                              else
                                next[service.id] = {
                                  role:
                                    (['api', 'frontend', 'worker'] as const).find(
                                      (role) =>
                                        !Object.values(current).some((v) => v.role === role),
                                    ) ?? 'api',
                                  preserveEnvironmentKeys: (service.environmentKeys ?? []).filter(
                                    (key) =>
                                      /DATABASE|DIRECT_URL|POSTGRES|(^|_)PG_|(^|_)DB_|SUPABASE|REDIS|PASSWORD|SECRET|TOKEN|ENCRYPTION|OAUTH|(^|_)API_KEY/.test(
                                        key,
                                      ),
                                  ),
                                  startupReviewed: false,
                                };
                              return next;
                            });
                          }}
                        />
                        {service.name}
                      </Label>
                      {member && (
                        <>
                          <Label htmlFor={`role-${service.id}`}>Papel confirmado</Label>
                          <select
                            id={`role-${service.id}`}
                            className="native-select w-full"
                            value={member.role}
                            onChange={(e) => {
                              setSelected(null);
                              setSwarmMembers((current) => ({
                                ...current,
                                [service.id]: { ...member, role: e.target.value as SwarmRole },
                              }));
                            }}
                          >
                            <option value="api">API</option>
                            <option value="frontend">Interface</option>
                            <option value="worker">Worker</option>
                          </select>
                          <fieldset className="space-y-2">
                            <legend className="text-sm font-medium">
                              Manter valores atuais destas variáveis no retorno
                            </legend>
                            <p className="text-xs text-muted-foreground">
                              As variáveis marcadas usam seus valores atuais, prevalecendo sobre o
                              backup. Revise conexões de banco e chaves compatíveis. As demais
                              voltam ao valor histórico; somente os nomes são exibidos.
                            </p>
                            {(service.environmentKeys ?? []).map((key) => (
                              <Label key={key} className="flex items-center gap-2 break-all">
                                <input
                                  type="checkbox"
                                  checked={member.preserveEnvironmentKeys.includes(key)}
                                  onChange={(e) => {
                                    setSelected(null);
                                    setSwarmMembers((current) => ({
                                      ...current,
                                      [service.id]: {
                                        ...member,
                                        preserveEnvironmentKeys: e.target.checked
                                          ? [...member.preserveEnvironmentKeys, key]
                                          : member.preserveEnvironmentKeys.filter((v) => v !== key),
                                      },
                                    }));
                                  }}
                                />
                                {key}
                              </Label>
                            ))}
                          </fieldset>
                          <Label className="flex items-start gap-2">
                            <input
                              type="checkbox"
                              checked={member.startupReviewed}
                              onChange={(e) => {
                                setSelected(null);
                                setSwarmMembers((current) => ({
                                  ...current,
                                  [service.id]: { ...member, startupReviewed: e.target.checked },
                                }));
                              }}
                            />
                            Revisei o comando de inicialização: ele não deve aplicar migrations ou
                            alterar o banco durante este retorno.
                          </Label>
                        </>
                      )}
                    </div>
                  );
                })}
                {!catalog.data?.services.length && (
                  <p role="status">Nenhum serviço Swarm disponível nesta descoberta.</p>
                )}
                {new Set(Object.values(swarmMembers).map((v) => v.role)).size !==
                  Object.keys(swarmMembers).length && (
                  <p role="alert">Cada serviço deve ter um papel distinto.</p>
                )}
                <Button
                  disabled={
                    !canConfigure ||
                    select.isPending ||
                    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(swarmName) ||
                    !Object.keys(swarmMembers).length ||
                    Object.values(swarmMembers).some((v) => !v.startupReviewed) ||
                    new Set(Object.values(swarmMembers).map((v) => v.role)).size !==
                      Object.keys(swarmMembers).length
                  }
                  onClick={() => select.mutate(swarmName)}
                >
                  Selecionar grupo Swarm
                </Button>
              </fieldset>
            )}
            {kind !== 'swarm' && (
              <>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="min-w-0 flex-1">
                    <Label htmlFor="docker-search">Buscar nome do recurso</Label>
                    <div className="relative">
                      <Search
                        className="absolute left-3 top-3 h-4 w-4 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <Input
                        id="docker-search"
                        className="pl-9"
                        value={search}
                        onChange={(e) => {
                          setSearch(e.target.value);
                          setPage(1);
                        }}
                      />
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    disabled={catalog.isFetching}
                    onClick={() => void catalog.refetch()}
                  >
                    Atualizar descoberta
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {filtered.length
                    ? `${(page - 1) * 10 + 1}–${Math.min(page * 10, filtered.length)}`
                    : '0'}{' '}
                  de {filtered.length} recursos · atualizado em{' '}
                  {new Date(catalog.data!.capturedAt).toLocaleTimeString('pt-BR')}
                </p>
                <div className="space-y-2">
                  {filtered.slice((page - 1) * 10, page * 10).map((r) => (
                    <article
                      key={r.name}
                      className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <h3 className="break-all font-semibold">{r.name}</h3>
                        <p className="break-all text-xs text-muted-foreground">{r.detail}</p>
                        {r.blocked && (
                          <p className="mt-1 text-xs text-muted-foreground">{r.blocked}</p>
                        )}
                      </div>
                      {canConfigure && (
                        <Button
                          aria-label={`Selecionar ${r.name}`}
                          className="shrink-0"
                          variant="outline"
                          disabled={!!r.blocked || select.isPending}
                          onClick={() => select.mutate(r.name)}
                        >
                          Selecionar
                        </Button>
                      )}
                    </article>
                  ))}
                </div>
                {!filtered.length && (
                  <p className="text-muted-foreground">
                    {search
                      ? 'Nenhum resultado. Ajuste a busca.'
                      : 'Nenhum recurso deste tipo. Confira a configuração do agente.'}
                  </p>
                )}
                <nav
                  aria-label="Paginação dos recursos"
                  className="flex flex-wrap items-center justify-between gap-2"
                >
                  <span>
                    Página {page} de {pages}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      disabled={page === 1}
                      onClick={() => setPage((p) => p - 1)}
                    >
                      Anterior
                    </Button>
                    <Button
                      variant="outline"
                      disabled={page >= pages}
                      onClick={() => setPage((p) => p + 1)}
                    >
                      Próxima
                    </Button>
                  </div>
                </nav>
              </>
            )}
            {kind !== 'swarm' && !!catalog.data?.services.length && (
              <p className="text-xs text-muted-foreground">
                {catalog.data.services.length} serviço(s) Swarm descoberto(s). Retorno pelo tipo
                Aplicação Swarm permite selecionar seus papéis explicitamente.
              </p>
            )}
          </>
        )}
        {!canConfigure && (
          <p className="text-muted-foreground">
            Somente administradores configuram recursos e planos. Ações protegidas exigem identidade
            confirmada em{' '}
            <Link to="/security" className="text-primary underline">
              Segurança
            </Link>
            .
          </p>
        )}
      </section>
      {selected && canConfigure && (
        <section className="space-y-4 rounded-lg border bg-card p-4">
          <h2 className="text-xl font-semibold">2. Proteger {selected.identity}</h2>
          <form className="grid gap-3" onSubmit={planForm.handleSubmit((v) => plan.mutate(v))}>
            <Label htmlFor="docker-plan">Nome do plano</Label>
            <Input id="docker-plan" {...planForm.register('name')} />
            <Label htmlFor="docker-destination">Destino local Restic</Label>
            <select
              id="docker-destination"
              className="native-select"
              value={planForm.watch('destinationId')}
              onChange={(event) => {
                const previous = planForm.getValues('destinationId');
                planForm.setValue('destinationId', event.target.value);
                planForm.setValue(
                  'destinationIds',
                  [
                    event.target.value,
                    ...(planForm.getValues('destinationIds') ?? []).filter(
                      (id) => id !== previous && id !== event.target.value,
                    ),
                  ].filter(Boolean),
                );
              }}
            >
              <option value="">Selecione um destino</option>
              {destinations.data?.items
                .filter((d) => d.destinationKind === 'local' && d.localCapture === true)
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
            </select>
            <AdditionalDestinations
              items={destinations.data?.items ?? []}
              primary={planForm.watch('destinationId')}
              value={planForm.watch('destinationIds') ?? []}
              onChange={(ids) => planForm.setValue('destinationIds', ids)}
            />
            <Link
              to="/$section"
              params={{ section: 'destinations' }}
              search={{}}
              className="text-primary underline"
            >
              Configurar destinos
            </Link>
            <Label className="flex items-center gap-2">
              <input type="checkbox" {...planForm.register('scheduleEnabled')} />
              Agendar backup diário
            </Label>
            {planForm.watch('scheduleEnabled') && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="docker-time">Horário local</Label>
                  <Input id="docker-time" type="time" {...planForm.register('localTime')} />
                </div>
                <div>
                  <Label htmlFor="docker-zone">Fuso horário IANA</Label>
                  <Input id="docker-zone" {...planForm.register('timezone')} />
                </div>
              </div>
            )}
            {Object.entries(planForm.formState.errors).map(([key, value]) => (
              <p key={key} role="alert" className="text-xs text-destructive">
                {value.message}
              </p>
            ))}
            <Button disabled={plan.isPending}>
              {plan.isPending ? 'Criando plano…' : 'Criar plano de backup'}
            </Button>
          </form>
        </section>
      )}
      {overview.isPending ? (
        <DataState state="loading" />
      ) : overview.isError ? (
        <DataState state="error" onRetry={() => void refresh()} />
      ) : (
        <>
          <section className="space-y-3">
            <h2 className="text-xl font-semibold">Planos de Docker e arquivos</h2>
            {!overview.data?.plans.length ? (
              <p className="rounded-lg border bg-card p-6 text-muted-foreground">
                Selecione um recurso e crie seu primeiro plano.
              </p>
            ) : (
              overview.data.plans.map((p) => (
                <article
                  key={p.id}
                  className="flex flex-col gap-3 rounded-lg border bg-card p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <h3 className="break-all font-semibold">{p.name}</h3>
                    <p className="text-xs text-muted-foreground">
                      {kinds[p.selection.kind]} · {p.selection.identity}
                    </p>
                    <Badge variant="outline">
                      {p.latest ? humanLabel(p.latest.status) : 'Sem backup'}
                    </Badge>
                  </div>
                  {canBackup && (
                    <Button
                      aria-label={`Executar backup ${p.selection.identity}`}
                      disabled={
                        backup.isPending ||
                        (!!p.latest &&
                          [
                            'aguardando',
                            'verificando',
                            'capturando',
                            'enviando',
                            'verificando_destino',
                          ].includes(p.latest.status))
                      }
                      onClick={() => backup.mutate(p.id)}
                    >
                      <Play aria-hidden="true" />
                      Executar backup
                    </Button>
                  )}
                </article>
              ))
            )}
          </section>
          <section className="space-y-3">
            <h2 className="text-xl font-semibold">Pontos verificados</h2>
            <p className="text-xs text-muted-foreground">
              Aplicação inclui imagem exata exportada, configuração cifrada e arquivos dos mounts
              próprios. Banco, redes especiais, DNS e serviços externos não fazem parte desta ação.
            </p>
            {!overview.data?.points.length ? (
              <p className="rounded-lg border bg-card p-6 text-muted-foreground">
                Os pontos aparecerão após captura e verificação real do destino.
              </p>
            ) : (
              overview.data.points.slice((pointPage - 1) * 10, pointPage * 10).map((p) => (
                <article
                  key={p.id}
                  className="flex flex-col gap-3 rounded-lg border bg-card p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <h3 className="break-all font-semibold">{p.selection.identity}</h3>
                    <p className="text-xs text-muted-foreground">
                      {new Date(p.capturedAt).toLocaleString('pt-BR')} · consistência de falha
                    </p>
                    <p className="break-all text-xs text-muted-foreground">
                      Inclui: {p.evidence.components.join(', ')}
                    </p>
                    <Badge variant="outline">Restic e componentes verificados</Badge>
                    <PointDestinationStatus
                      pointId={p.id}
                      canBackup={canBackup}
                      canRetain={canConfigure}
                    />
                  </div>
                  {canRestore && (
                    <Button
                      variant="outline"
                      onClick={(event) => {
                        restoreTrigger.current = event.currentTarget;
                        openRestore(p);
                      }}
                    >
                      <ArchiveRestore aria-hidden="true" />
                      {p.selection.kind === 'container' || p.selection.kind === 'swarm'
                        ? 'Voltar aplicação sem banco'
                        : 'Restaurar para novo destino'}
                    </Button>
                  )}
                </article>
              ))
            )}
            <nav aria-label="Paginação dos pontos" className="flex items-center justify-end gap-2">
              <Button
                variant="outline"
                disabled={pointPage === 1}
                onClick={() => setPointPage((p) => p - 1)}
              >
                Anterior
              </Button>
              <Button
                variant="outline"
                disabled={pointPage * 10 >= (overview.data?.points.length ?? 0)}
                onClick={() => setPointPage((p) => p + 1)}
              >
                Próxima
              </Button>
            </nav>
          </section>
          <section className="space-y-3">
            <h2 className="text-xl font-semibold">Restaurações</h2>
            {!overview.data?.restores.length ? (
              <p className="text-muted-foreground">Nenhuma restauração solicitada.</p>
            ) : (
              overview.data.restores.map((r) => (
                <article key={r.id} className="rounded-lg border bg-card p-4">
                  <h3 className="break-all font-semibold">{r.targetName}</h3>
                  <Badge variant="outline">{humanLabel(r.status)}</Badge>
                  {r.evidence && (
                    <p className="mt-2 break-all text-xs text-muted-foreground">
                      Destino: {r.evidence.targets.join(', ')}.{' '}
                      {r.evidence.kind === 'swarm'
                        ? 'Grupo Swarm retornado. Confira o estado dos serviços antes de reativar deploys externos. Banco não alterado.'
                        : r.evidence.kind === 'container'
                          ? `Container em execução (${r.evidence.health === 'healthy' ? 'healthcheck aprovado' : 'sem healthcheck configurado'}). Original preservado: ${r.evidence.preservedContainerId}. Banco permanece uma ação independente.`
                          : 'Arquivos e permissões conferidos. Conecte o novo destino à aplicação somente após sua revisão.'}
                    </p>
                  )}
                  {r.status === 'exige_intervencao' && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Confira o journal do agente, os destinos identificados pela operação e o
                      container original antes de nova tentativa. A operação incerta não é repetida
                      automaticamente.
                    </p>
                  )}
                </article>
              ))
            )}
          </section>
        </>
      )}
      <Dialog
        open={!!restorePoint}
        onOpenChange={(open) => {
          if (!open && !restore.isPending) setRestorePoint(null);
        }}
      >
        <DialogContent
          className="configuration-dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreTrigger.current?.focus({ preventScroll: true });
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {restorePoint?.selection.kind === 'container' ||
              restorePoint?.selection.kind === 'swarm'
                ? 'Voltar aplicação sem banco'
                : 'Restaurar arquivos em destino novo'}
            </DialogTitle>
            <DialogDescription>
              {restorePoint?.selection.kind === 'swarm'
                ? 'Esta ação volta somente os serviços selecionados e seus arquivos. O banco não será restaurado. Desative deploys automáticos, webhooks e agendas externas antes de confirmar.'
                : restorePoint?.selection.kind === 'container'
                  ? 'Esta ação para somente o container identificado, volta imagem/configuração e arquivos históricos, e inicia o substituto. O original e seus dados ficam preservados. O banco não será restaurado.'
                  : 'O destino precisa estar ausente. Nenhum arquivo existente será mesclado ou sobrescrito.'}
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-3"
            onSubmit={restoreForm.handleSubmit((v) => restore.mutate(v))}
          >
            {restorePoint && (
              <RestoreRepository
                pointId={restorePoint.id}
                value={restoreForm.watch('repositoryId') ?? ''}
                onChange={(id) => restoreForm.setValue('repositoryId', id || undefined)}
                onAvailability={setRestoreAvailable}
              />
            )}
            <Label htmlFor="docker-target">
              {restorePoint?.selection.kind === 'container' ||
              restorePoint?.selection.kind === 'swarm'
                ? 'Container alvo'
                : 'Nome do novo destino'}
            </Label>
            <Input
              id="docker-target"
              readOnly={
                restorePoint?.selection.kind === 'container' ||
                restorePoint?.selection.kind === 'swarm'
              }
              {...restoreForm.register('targetName')}
            />
            {(restorePoint?.selection.kind === 'container' ||
              restorePoint?.selection.kind === 'swarm') && (
              <>
                <Label htmlFor="docker-confirm">
                  Digite o nome exato para confirmar a parada e o retorno
                </Label>
                <Input
                  id="docker-confirm"
                  autoComplete="off"
                  {...restoreForm.register('confirmation')}
                />
              </>
            )}
            {restorePoint?.selection.kind === 'swarm' && (
              <Label className="flex items-start gap-2">
                <input type="checkbox" {...restoreForm.register('redeployGuardConfirmed')} />
                Desativei redeploys, webhooks e agendas externas. Vou alinhar a configuração
                histórica no Dokploy antes de reativá-los. O banco será tratado separadamente.
              </Label>
            )}
            {Object.entries(restoreForm.formState.errors).map(([key, value]) => (
              <p key={key} role="alert" className="text-xs text-destructive">
                {value.message}
              </p>
            ))}
            {restore.error && (
              <p role="alert" className="text-destructive">
                {restore.error.message}
              </p>
            )}
            <Button disabled={restore.isPending || !restoreAvailable}>
              {restore.isPending ? 'Solicitando…' : 'Confirmar restauração'}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

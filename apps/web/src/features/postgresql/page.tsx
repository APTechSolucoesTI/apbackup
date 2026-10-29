import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from '@tanstack/react-router';
import { z } from 'zod';
import { Database, Play, RefreshCw, ShieldCheck, ArchiveRestore } from 'lucide-react';
import { toast } from 'sonner';
import {
  postgresConnectionInputSchema,
  postgresConnectionSchema,
  postgresPlanSchema,
  postgresDatabaseNameSchema,
  optionsResultSchema,
  destinationReadSchema,
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
      database: z.string(),
      enabled: z.boolean(),
      scheduleEnabled: z.boolean(),
      localTime: z.string(),
      timezone: z.string(),
      latest: z.object({ id: z.uuid(), status: z.string() }).nullable(),
    }),
  ),
  points: z.array(
    z.object({
      id: z.uuid(),
      database: z.string(),
      capturedAt: z.string(),
      snapshotId: z.string(),
      verification: z.string(),
    }),
  ),
  restores: z.array(z.object({ id: z.uuid(), database: z.string(), status: z.string() })),
});
const idSchema = z.object({ id: z.uuid() }),
  selectedSchema = z.object({ profileVersionId: z.uuid(), resourceId: z.uuid() }),
  executionSchema = z.object({ executionId: z.uuid() });
const destinationFormSchema = z.object({
  name: z.string().trim().min(1, 'Informe um nome.'),
  rootPath: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/, 'Use letras, números, hífen ou sublinhado.'),
  secret: z.string().min(12, 'Use ao menos 12 caracteres para proteger o repositório.'),
});
const restoreFormSchema = z.object({ targetDatabase: postgresDatabaseNameSchema });
async function pgRequest<T>(path: string, schema: z.ZodType<T>, value?: unknown): Promise<T> {
  const response = await fetch(`/api/postgresql/${path}`, {
    credentials: 'same-origin',
    ...(value === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(value),
        }),
  });
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(await response.json());
    throw new Error(
      error.success ? error.data.error : 'Não foi possível concluir. Tente novamente.',
    );
  }
  return schema.parse(await response.json());
}
export function PostgresPage() {
  const session = ProtectedRoute.useRouteContext().identity;
  const canConfigure = session.status === 'ok' && session.session.canConfigure,
    role = session.status === 'ok' ? session.session.role : 'viewer';
  const canBackup = role === 'administrator' || role === 'backup_operator',
    canRestore = role === 'administrator' || role === 'restore_operator';
  const queryClient = useQueryClient(),
    refresh = () => queryClient.invalidateQueries({ queryKey: ['postgresql'] });
  const [connectionId, setConnectionId] = useState(''),
    [databaseChoice, setDatabaseChoice] = useState(''),
    [schemaChoices, setSchemaChoices] = useState<string[]>([]),
    [selected, setSelected] = useState<{
      profileVersionId: string;
      database: string;
      schemas: string[];
    } | null>(null),
    [restorePoint, setRestorePoint] = useState<{ id: string; database: string } | null>(null),
    [activeExecution, setActiveExecution] = useState('');
  const [restoreRepositoryId, setRestoreRepositoryId] = useState(''),
    [restoreAvailable, setRestoreAvailable] = useState(false);
  const restoreTrigger = useRef<HTMLButtonElement | null>(null);
  const connections = useQuery({
    queryKey: ['postgresql', 'connections'],
    queryFn: () => pgRequest('connections', z.object({ items: z.array(postgresConnectionSchema) })),
  });
  const servers = useQuery({
    queryKey: ['postgresql', 'servers'],
    queryFn: () => configurationRequest('options?kind=servers', optionsResultSchema),
    enabled: canConfigure,
  });
  const destinations = useQuery({
    queryKey: ['postgresql', 'destinations'],
    queryFn: () => configurationRequest('options?kind=destinations', optionsResultSchema),
    enabled: canConfigure,
  });
  const overview = useQuery({
    queryKey: ['postgresql', 'overview'],
    queryFn: () => pgRequest('overview', overviewSchema),
    refetchInterval: 3000,
  });
  const execution = useQuery({
    queryKey: ['postgresql', 'execution', activeExecution],
    queryFn: () =>
      api(
        `/api/runtime/executions/${activeExecution}`,
        z.object({ status: z.string(), events: z.array(z.object({ code: z.string() })) }),
      ),
    enabled: !!activeExecution,
    refetchInterval: 3000,
  });
  const connectionForm = useForm<
    z.input<typeof postgresConnectionInputSchema>,
    unknown,
    z.output<typeof postgresConnectionInputSchema>
  >({
    resolver: zodResolver(postgresConnectionInputSchema),
    defaultValues: {
      name: 'PostgreSQL',
      serverId: '',
      host: '',
      port: 5432,
      username: 'backup',
      password: '',
      sslMode: 'verify-full',
    },
  });
  const destinationForm = useForm<z.infer<typeof destinationFormSchema>>({
    resolver: zodResolver(destinationFormSchema),
    defaultValues: { name: 'Backup local', rootPath: 'postgresql_backups', secret: '' },
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
  const restoreForm = useForm<z.infer<typeof restoreFormSchema>>({
    resolver: zodResolver(restoreFormSchema),
    defaultValues: { targetDatabase: '' },
  });
  const createConnection = useMutation({
    mutationFn: (v: z.output<typeof postgresConnectionInputSchema>) =>
      pgRequest('connections', postgresConnectionSchema, v),
    onSuccess: (data) => {
      setConnectionId(data.id);
      connectionForm.resetField('password');
      void refresh();
      toast.success('Conexão guardada com criptografia.');
    },
  });
  const discover = useMutation({
    mutationFn: () =>
      pgRequest(
        `connections/${connectionId}/discover`,
        z.object({ databases: z.array(z.object({ name: z.string() })), serverMajor: z.number() }),
        {},
      ),
    onSuccess: () => {
      setSelected(null);
      setDatabaseChoice('');
      setSchemaChoices([]);
    },
  });
  const schemas = useQuery({
    queryKey: ['postgresql', 'schemas', connectionId, databaseChoice],
    queryFn: () =>
      pgRequest(
        `connections/${connectionId}/schemas`,
        z.object({
          schemas: z.array(z.object({ name: z.string(), selectable: z.boolean() })),
          limitation: z.string().nullable().optional(),
        }),
        { database: databaseChoice },
      ),
    enabled: !!connectionId && !!databaseChoice && canConfigure,
  });
  const select = useMutation({
    mutationFn: ({ database, schemas: scope }: { database: string; schemas: string[] }) =>
      pgRequest('select', selectedSchema, { connectionId, database, schemas: scope }),
    onSuccess: (data, { database, schemas: scope }) => {
      setSelected({ profileVersionId: data.profileVersionId, database, schemas: scope });
      planForm.setValue('profileVersionId', data.profileVersionId);
      planForm.setValue(
        'name',
        `Backup ${database}${scope.length ? ' · ' + scope.join(', ') : ''}`,
      );
    },
  });
  const createDestination = useMutation({
    mutationFn: (v: z.infer<typeof destinationFormSchema>) =>
      configurationRequest('destinations', destinationReadSchema, {
        name: v.name,
        kind: 'local',
        host: null,
        engine: 'restic',
        rootPath: v.rootPath,
        status: 'ativo',
        credential: { secret: v.secret },
      }),
    onSuccess: (data) => {
      destinationForm.resetField('secret');
      planForm.setValue('destinationId', data.id);
      void refresh();
      toast.success('Destino local cadastrado.');
    },
  });
  const createPlan = useMutation({
    mutationFn: (v: z.output<typeof postgresPlanSchema>) => pgRequest('plans', idSchema, v),
    onSuccess: () => {
      setSelected(null);
      void refresh();
      toast.success('Plano criado. Você já pode executar o backup.');
    },
  });
  const backup = useMutation({
    mutationFn: (planId: string) =>
      api('/api/runtime/execute', executionSchema, { planId, idempotencyKey: crypto.randomUUID() }),
    onSuccess: (data) => {
      setActiveExecution(data.executionId);
      void refresh();
      toast.success('Backup entrou na fila do agente.');
    },
  });
  const restore = useMutation({
    mutationFn: async (v: z.infer<typeof restoreFormSchema>) => {
      if (!restoreAvailable || !restoreRepositoryId)
        throw new Error('Escolha uma cópia verificada para restaurar.');
      return api('/api/runtime/restore-postgresql', executionSchema, {
        recoveryPointId: restorePoint!.id,
        repositoryId: restoreRepositoryId,
        targetDatabase: v.targetDatabase,
        idempotencyKey: crypto.randomUUID(),
      });
    },
    onSuccess: (data) => {
      setActiveExecution(data.executionId);
      setRestorePoint(null);
      void refresh();
      toast.success('Restauração entrou na fila. O banco original será preservado.');
    },
  });
  const error = [
    createConnection.error,
    discover.error,
    select.error,
    createDestination.error,
    createPlan.error,
    backup.error,
    restore.error,
  ].find(Boolean);
  const [pointPage, setPointPage] = useState(1),
    points = overview.data?.points ?? [],
    pages = Math.max(1, Math.ceil(points.length / 10));
  return (
    <div className="pg-page">
      <header className="page-header">
        <div>
          <p className="text-xs font-semibold text-primary">PROTEÇÃO DE RECURSOS</p>
          <h1>PostgreSQL</h1>
          <p className="text-muted-foreground">
            Proteja um banco e recupere seus dados em um banco novo.
          </p>
        </div>
        <Button variant="outline" onClick={() => void refresh()}>
          <RefreshCw aria-hidden="true" />
          Atualizar
        </Button>
      </header>
      <aside className="rounded-lg border bg-secondary p-4 text-secondary-foreground">
        <ShieldCheck className="mr-2 inline h-4 w-4" aria-hidden="true" />
        PostgreSQL 17 · captura transacional · Restic cifrado. O destino local fica no mesmo host e
        não protege contra a perda desse host.
      </aside>
      {error && (
        <p role="alert" className="rounded-md border border-destructive p-3 text-destructive">
          {error.message}
        </p>
      )}
      {!canConfigure && (
        <p className="text-muted-foreground">
          Somente administradores podem configurar conexões e planos. Para ações protegidas,
          verifique sua identidade em{' '}
          <Link to="/security" className="text-primary underline">
            Segurança
          </Link>
          .
        </p>
      )}
      {canConfigure && (
        <section className="pg-setup rounded-lg border bg-card p-4">
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">1. Conectar e descobrir</h2>
            <Label htmlFor="pg-connection">Conexão guardada</Label>
            <select
              id="pg-connection"
              className="native-select w-full"
              value={connectionId}
              onChange={(event) => {
                setConnectionId(event.target.value);
                discover.reset();
                setSelected(null);
                setDatabaseChoice('');
                setSchemaChoices([]);
              }}
            >
              <option value="">Selecione uma conexão</option>
              {connections.data?.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.host}:{c.port}
                </option>
              ))}
            </select>
            <Button
              disabled={!connectionId || discover.isPending}
              onClick={() => discover.mutate()}
            >
              <Database aria-hidden="true" />
              {discover.isPending ? 'Testando conexão…' : 'Testar e descobrir bancos'}
            </Button>
            <details open={!connections.data?.items.length}>
              <summary className="cursor-pointer font-semibold text-primary">
                Cadastrar conexão PostgreSQL
              </summary>
              <form
                className="mt-4 grid gap-3"
                onSubmit={connectionForm.handleSubmit((v) => createConnection.mutate(v))}
              >
                <Label htmlFor="pg-server">Servidor</Label>
                <select
                  id="pg-server"
                  className="native-select"
                  {...connectionForm.register('serverId')}
                >
                  <option value="">Selecione o servidor</option>
                  {servers.data?.items.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
                {!servers.data?.items.length && (
                  <Link
                    to="/$section"
                    params={{ section: 'servers' }}
                    search={{}}
                    className="text-primary underline"
                  >
                    Cadastrar o primeiro servidor
                  </Link>
                )}
                <Label htmlFor="pg-name">Nome da conexão</Label>
                <Input id="pg-name" {...connectionForm.register('name')} />
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="sm:col-span-2">
                    <Label htmlFor="pg-host">Host aprovado</Label>
                    <Input id="pg-host" {...connectionForm.register('host')} />
                  </div>
                  <div>
                    <Label htmlFor="pg-port">Porta</Label>
                    <Input
                      id="pg-port"
                      type="number"
                      {...connectionForm.register('port', { valueAsNumber: true })}
                    />
                  </div>
                </div>
                <Label htmlFor="pg-user">Usuário PostgreSQL</Label>
                <Input id="pg-user" autoComplete="off" {...connectionForm.register('username')} />
                <Label htmlFor="pg-password">Senha PostgreSQL</Label>
                <Input
                  id="pg-password"
                  type="password"
                  autoComplete="new-password"
                  {...connectionForm.register('password')}
                />
                <Label htmlFor="pg-tls">Transporte</Label>
                <select
                  id="pg-tls"
                  className="native-select"
                  {...connectionForm.register('sslMode')}
                >
                  <option value="verify-full">TLS com certificado verificado</option>
                  <option value="disable">Sem TLS (somente loopback local)</option>
                </select>
                <p className="text-xs text-muted-foreground">
                  O host deve estar aprovado no servidor e no agente. A senha é cifrada e não será
                  exibida novamente.
                </p>
                {Object.entries(connectionForm.formState.errors).map(([key, value]) => (
                  <p key={key} role="alert" className="text-xs text-destructive">
                    {key}: {value.message}
                  </p>
                ))}
                <Button disabled={createConnection.isPending}>
                  {createConnection.isPending ? 'Guardando…' : 'Guardar conexão'}
                </Button>
              </form>
            </details>
          </div>
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">2. Escolher banco e plano</h2>
            {!discover.data && (
              <p className="text-muted-foreground">
                Teste uma conexão para ver os bancos acessíveis. Nenhuma captura é iniciada durante
                a descoberta.
              </p>
            )}
            {discover.data && discover.data.databases.length === 0 && (
              <p role="status">
                Nenhum banco de aplicação acessível. Verifique as permissões de conexão.
              </p>
            )}
            {discover.data && (
              <div className="flex flex-wrap gap-2" aria-label="Bancos descobertos">
                {discover.data.databases.map((d) => (
                  <Button
                    key={d.name}
                    variant={selected?.database === d.name ? 'default' : 'outline'}
                    disabled={select.isPending}
                    onClick={() => {
                      setDatabaseChoice(d.name);
                      setSchemaChoices([]);
                      setSelected(null);
                      if (d.name !== 'postgres') select.mutate({ database: d.name, schemas: [] });
                    }}
                    aria-pressed={databaseChoice === d.name}
                  >
                    {d.name}
                  </Button>
                ))}
              </div>
            )}
            {databaseChoice && (
              <fieldset className="space-y-3 rounded-md border p-3">
                <legend className="px-1 font-semibold">Schemas de {databaseChoice}</legend>
                <p className="text-xs text-muted-foreground">
                  Selecione os schemas da aplicação para proteger uma parte do banco compartilhado.
                  Auth, Storage e outros schemas globais não serão restaurados automaticamente.
                </p>
                {schemas.isPending ? (
                  <p role="status">Consultando schemas…</p>
                ) : schemas.isError ? (
                  <DataState state="error" onRetry={() => void schemas.refetch()} />
                ) : (
                  <>
                    {schemas.data?.limitation && (
                      <p role="status" className="text-xs text-muted-foreground">
                        {schemas.data.limitation}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-3">
                      {schemas.data?.schemas.map((s) => (
                        <Label key={s.name} className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            disabled={!s.selectable || select.isPending}
                            checked={schemaChoices.includes(s.name)}
                            onChange={(e) => {
                              setSchemaChoices((current) =>
                                e.target.checked
                                  ? [...current, s.name]
                                  : current.filter((name) => name !== s.name),
                              );
                              setSelected(null);
                            }}
                          />
                          {s.name}
                          {!s.selectable && ' (global ou dependente)'}
                        </Label>
                      ))}
                    </div>
                    {!schemas.data?.schemas.length && (
                      <p role="status">Nenhum schema acessível para seleção.</p>
                    )}
                    <Button
                      variant="outline"
                      disabled={!schemaChoices.length || select.isPending}
                      onClick={() =>
                        select.mutate({ database: databaseChoice, schemas: schemaChoices })
                      }
                    >
                      Usar schemas selecionados
                    </Button>
                    {
                      <Button
                        variant="ghost"
                        disabled={select.isPending}
                        onClick={() => {
                          setSchemaChoices([]);
                          select.mutate({ database: databaseChoice, schemas: [] });
                        }}
                      >
                        {databaseChoice === 'postgres'
                          ? 'Usar banco compartilhado inteiro'
                          : 'Usar banco inteiro'}
                      </Button>
                    }
                    {databaseChoice === 'postgres' && (
                      <p className="text-xs text-muted-foreground">
                        O backup do banco inteiro inclui todos os schemas acessíveis. A restauração
                        continua criando outro banco; não substitui o Supabase em uso.
                      </p>
                    )}
                  </>
                )}
              </fieldset>
            )}
            {selected && (
              <form
                className="grid gap-3"
                onSubmit={planForm.handleSubmit((v) => createPlan.mutate(v))}
              >
                <p className="font-semibold">
                  Banco selecionado: <span className="font-mono">{selected.database}</span>
                  {selected.schemas.length > 0 && (
                    <span className="block text-sm font-normal">
                      Schemas: {selected.schemas.join(', ')}
                    </span>
                  )}
                </p>
                <Label htmlFor="pg-plan">Nome do plano</Label>
                <Input id="pg-plan" {...planForm.register('name')} />
                <Label htmlFor="pg-destination">Destino local Restic</Label>
                <select
                  id="pg-destination"
                  className="native-select"
                  value={planForm.watch('destinationId') ?? ''}
                  {...planForm.register('destinationId')}
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
                  <option value="">Selecione um destino local ativo</option>
                  {destinations.data?.items
                    .filter((d) => d.destinationKind === 'local' && d.localCapture === true)
                    .map((d) => (
                      <option value={d.id} key={d.id}>
                        {d.label} · {d.detail}
                      </option>
                    ))}
                </select>
                <AdditionalDestinations
                  items={destinations.data?.items ?? []}
                  primary={planForm.watch('destinationId')}
                  value={planForm.watch('destinationIds') ?? []}
                  onChange={(ids) => planForm.setValue('destinationIds', ids)}
                />
                <Label className="flex items-center gap-2">
                  <input type="checkbox" {...planForm.register('scheduleEnabled')} />
                  Agendar backup diário
                </Label>
                {planForm.watch('scheduleEnabled') && (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <Label htmlFor="pg-time">Horário local</Label>
                      <Input id="pg-time" type="time" {...planForm.register('localTime')} />
                    </div>
                    <div>
                      <Label htmlFor="pg-timezone">Fuso horário IANA</Label>
                      <Input id="pg-timezone" {...planForm.register('timezone')} />
                    </div>
                  </div>
                )}
                {Object.entries(planForm.formState.errors).map(([key, value]) => (
                  <p key={key} role="alert" className="text-xs text-destructive">
                    {key}: {value.message}
                  </p>
                ))}
                <Button disabled={createPlan.isPending}>
                  {createPlan.isPending ? 'Criando plano…' : 'Criar plano de backup'}
                </Button>
              </form>
            )}
            <details>
              <summary className="cursor-pointer font-semibold text-primary">
                Cadastrar destino local
              </summary>
              <form
                className="mt-4 grid gap-3"
                onSubmit={destinationForm.handleSubmit((v) => createDestination.mutate(v))}
              >
                <Label htmlFor="pg-dest-name">Nome do destino</Label>
                <Input id="pg-dest-name" {...destinationForm.register('name')} />
                <Label htmlFor="pg-folder">Pasta do repositório</Label>
                <Input id="pg-folder" {...destinationForm.register('rootPath')} />
                <p className="text-xs text-muted-foreground">
                  Pasta relativa à raiz privada aprovada do agente. Cada repositório deve ter sua
                  própria pasta.
                </p>
                <Label htmlFor="pg-repo-password">Senha de criptografia Restic</Label>
                <Input
                  id="pg-repo-password"
                  type="password"
                  autoComplete="new-password"
                  {...destinationForm.register('secret')}
                />
                <p className="text-xs text-muted-foreground">
                  Guarde esta senha e a chave do cofre fora do host. Sem elas o backup não pode ser
                  recuperado.
                </p>
                {Object.values(destinationForm.formState.errors).map((value, i) => (
                  <p key={i} role="alert" className="text-xs text-destructive">
                    {value.message}
                  </p>
                ))}
                <Button variant="outline" disabled={createDestination.isPending}>
                  {createDestination.isPending ? 'Guardando…' : 'Guardar destino local'}
                </Button>
              </form>
            </details>
          </div>
        </section>
      )}
      {overview.isPending ? (
        <DataState state="loading" />
      ) : overview.isError ? (
        <DataState state="error" onRetry={() => void refresh()} />
      ) : (
        <>
          <section className="space-y-3">
            <h2 className="text-xl font-semibold">Planos de banco</h2>
            {overview.data?.plans.length === 0 ? (
              <div className="rounded-lg border bg-card p-6 text-muted-foreground">
                Selecione um banco e crie seu primeiro plano para começar a proteção.
              </div>
            ) : (
              overview.data?.plans.map((p) => (
                <article
                  key={p.id}
                  className="flex flex-wrap items-center justify-between gap-4 rounded-lg border bg-card p-4"
                >
                  <div className="min-w-0">
                    <h3 className="break-words text-base font-semibold">{p.name}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      <span className="font-mono">{p.database}</span> ·{' '}
                      {p.scheduleEnabled
                        ? `Diário às ${p.localTime} (${p.timezone})`
                        : 'Execução manual'}{' '}
                      · {p.latest ? humanLabel(p.latest.status) : 'Aguardando primeiro backup'}
                    </p>
                  </div>
                  <Button
                    disabled={!canBackup || backup.isPending}
                    onClick={() => backup.mutate(p.id)}
                  >
                    <Play aria-hidden="true" />
                    Executar backup
                  </Button>
                </article>
              ))
            )}
          </section>
          {activeExecution && (
            <div className="rounded-lg border bg-card p-4" role="status">
              <strong>
                Última ação: {execution.data ? humanLabel(execution.data.status) : 'Aguardando…'}
              </strong>
              <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                {activeExecution}
              </p>
              {execution.data?.status === 'exige_intervencao' && (
                <p className="mt-2">
                  O agente precisa de verificação. Confira conexão, permissões, runtime e o estado
                  do banco de destino antes de tentar uma nova operação.
                </p>
              )}
            </div>
          )}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold">Pontos de recuperação verificados</h2>
            <p className="text-xs text-muted-foreground">
              Arquivo recuperado do Restic com hash conferido. A restauração cria um banco novo;
              donos e permissões são atribuídos ao usuário da conexão.
            </p>
            {points.length === 0 ? (
              <div className="rounded-lg border bg-card p-6 text-muted-foreground">
                Nenhum ponto verificado. Execute um backup e aguarde a confirmação do agente.
              </div>
            ) : (
              <>
                <div className="grid gap-3">
                  {points
                    .slice((Math.min(pointPage, pages) - 1) * 10, Math.min(pointPage, pages) * 10)
                    .map((p) => (
                      <article
                        key={p.id}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4"
                      >
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono font-semibold">{p.database}</span>
                            <Badge>Verificado</Badge>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {new Date(p.capturedAt).toLocaleString('pt-BR')}
                          </p>
                          <p
                            className="mt-1 break-all font-mono text-xs text-muted-foreground"
                            title={p.snapshotId}
                          >
                            Snapshot {p.snapshotId}
                          </p>
                          <PointDestinationStatus
                            pointId={p.id}
                            canBackup={canBackup}
                            canRetain={canConfigure}
                          />
                        </div>
                        <Button
                          variant="outline"
                          disabled={!canRestore}
                          onClick={(event) => {
                            restoreTrigger.current = event.currentTarget;
                            restoreForm.reset({
                              targetDatabase: `${p.database.slice(0, 45)}_recuperado`,
                            });
                            setRestorePoint(p);
                            setRestoreRepositoryId('');
                            setRestoreAvailable(false);
                          }}
                        >
                          <ArchiveRestore aria-hidden="true" />
                          Restaurar em banco novo
                        </Button>
                      </article>
                    ))}
                </div>
                <nav
                  className="flex flex-wrap items-center justify-between gap-2"
                  aria-label="Paginação dos pontos"
                >
                  <span className="text-xs text-muted-foreground">
                    {(Math.min(pointPage, pages) - 1) * 10 + 1}–
                    {Math.min(points.length, Math.min(pointPage, pages) * 10)} de {points.length}
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      disabled={pointPage <= 1}
                      onClick={() => setPointPage((p) => p - 1)}
                    >
                      Anterior
                    </Button>
                    <span className="text-xs">
                      Página {Math.min(pointPage, pages)} de {pages}
                    </span>
                    <Button
                      variant="outline"
                      disabled={pointPage >= pages}
                      onClick={() => setPointPage((p) => p + 1)}
                    >
                      Próxima
                    </Button>
                  </div>
                </nav>
              </>
            )}
          </section>
          {!!overview.data?.restores.length && (
            <section className="space-y-3">
              <h2 className="text-xl font-semibold">Restaurações</h2>
              {overview.data.restores.map((r) => (
                <div
                  key={r.id}
                  className="flex flex-wrap justify-between gap-3 rounded-lg border bg-card p-4"
                >
                  <span className="font-mono">{r.database}</span>
                  <span>{humanLabel(r.status)}</span>
                </div>
              ))}
            </section>
          )}
        </>
      )}
      <Dialog
        open={!!restorePoint}
        onOpenChange={(open) => {
          if (!restore.isPending && !open) setRestorePoint(null);
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreTrigger.current?.focus({ preventScroll: true });
          }}
        >
          <DialogHeader>
            <DialogTitle>Restaurar em banco novo</DialogTitle>
            <DialogDescription>
              O banco de origem será preservado. O nome informado deve estar disponível. O usuário
              da conexão será dono dos objetos recuperados; grants originais não serão reaplicados.
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={restoreForm.handleSubmit((v) => restore.mutate(v))}
          >
            <Label htmlFor="pg-new-database">Nome do banco novo</Label>
            {restorePoint && (
              <RestoreRepository
                pointId={restorePoint.id}
                value={restoreRepositoryId}
                onChange={setRestoreRepositoryId}
                onAvailability={setRestoreAvailable}
              />
            )}
            <Input id="pg-new-database" {...restoreForm.register('targetDatabase')} />
            {restoreForm.formState.errors.targetDatabase && (
              <p role="alert" className="text-destructive">
                {restoreForm.formState.errors.targetDatabase.message}
              </p>
            )}
            {restore.error && (
              <p role="alert" className="text-destructive">
                {restore.error.message}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={restore.isPending}
                onClick={() => setRestorePoint(null)}
              >
                Cancelar
              </Button>
              <Button disabled={restore.isPending || !restoreAvailable}>
                {restore.isPending ? 'Enfileirando…' : 'Criar banco e restaurar'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from '@tanstack/react-router';
import { z } from 'zod';
import { toast } from 'sonner';
import {
  dokployConnectionInputSchema,
  dokployConnectionSchema,
  dokployCatalogSchema,
  dokployNativeConfigurationSchema,
  dokployNativeSelectionSchema,
  optionsResultSchema,
} from '@apbackup/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { DataState } from '@/components/data-state';
import { api } from '@/lib/client-api';
import { configurationRequest } from '@/features/configuration/client';
import { Route as ProtectedRoute } from '@/routes/_authenticated';
type NativeSelection = z.infer<typeof dokployNativeSelectionSchema>;
const runsSchema = z.object({
  items: z.array(
    z.object({
      id: z.uuid(),
      selection: dokployNativeSelectionSchema,
      status: z.string(),
      artifacts: z.array(z.unknown()).nullable(),
      createdAt: z.string(),
      checkedAt: z.string().nullable(),
    }),
  ),
});
const statusLabels: Record<string, string> = {
  requested: 'Solicitado',
  accepted: 'Aguardando arquivo',
  pending_observation: 'Aguardando arquivo',
  artifact_observed: 'Arquivo encontrado',
  observed: 'Arquivo encontrado',
  unknown: 'Exige verificação',
  failed: 'Falhou',
};
export function DokployPage() {
  const identity = ProtectedRoute.useRouteContext().identity;
  const role = identity.status === 'ok' ? identity.session.role : 'viewer';
  const canConfigure = identity.status === 'ok' && identity.session.canConfigure;
  const canBackup = role === 'administrator' || role === 'backup_operator';
  const cache = useQueryClient();
  const [connectionId, setConnectionId] = useState(''),
    [search, setSearch] = useState(''),
    [page, setPage] = useState(1);
  const [resource, setResource] = useState<{
    id: string;
    kind: 'application' | 'compose' | 'postgres';
    name: string;
  } | null>(null);
  const connections = useQuery({
    queryKey: ['dokploy', 'connections'],
    queryFn: () =>
      api('/api/dokploy/connections', z.object({ items: z.array(dokployConnectionSchema) })),
  });
  const servers = useQuery({
    queryKey: ['dokploy', 'servers'],
    queryFn: () => configurationRequest('options?kind=servers', optionsResultSchema),
    enabled: canConfigure,
  });
  const runs = useQuery({
    queryKey: ['dokploy', 'runs'],
    queryFn: () => api('/api/dokploy/native/runs', runsSchema),
    refetchInterval: 5000,
  });
  const form = useForm<z.infer<typeof dokployConnectionInputSchema>>({
    resolver: zodResolver(dokployConnectionInputSchema),
    defaultValues: { serverId: '', name: 'Dokploy', endpoint: '', apiKey: '' },
  });
  const create = useMutation({
    mutationFn: (value: z.infer<typeof dokployConnectionInputSchema>) =>
      api('/api/dokploy/connections', dokployConnectionSchema, value),
    onSuccess: (data) => {
      setConnectionId(data.id);
      form.resetField('apiKey');
      void cache.invalidateQueries({ queryKey: ['dokploy', 'connections'] });
      toast.success('Conexão guardada com criptografia.');
    },
  });
  const discover = useMutation({
    mutationFn: () =>
      api(`/api/dokploy/connections/${connectionId}/discover`, dokployCatalogSchema, {}),
    onSuccess: () => {
      setResource(null);
      setPage(1);
    },
  });
  const native = useMutation({
    mutationFn: (selected: NonNullable<typeof resource>) =>
      api(
        '/api/dokploy/native/configurations',
        z.object({ items: z.array(dokployNativeConfigurationSchema) }),
        { connectionId, resourceId: selected.id, resourceType: selected.kind },
      ),
  });
  const run = useMutation({
    mutationFn: (selection: NativeSelection) =>
      api('/api/dokploy/native/run', z.object({ id: z.uuid(), status: z.string() }), {
        ...selection,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ['dokploy', 'runs'] });
      toast.success('Solicitação registrada. Acompanhe o arquivo e o resultado.');
    },
  });
  const connection = connections.data?.items.find((c) => c.id === connectionId);
  const error = [create.error, discover.error, native.error, run.error].find(Boolean);
  const filtered = (discover.data?.resources ?? []).filter((r) =>
    [r.name, r.project, r.environment, r.kind]
      .join(' ')
      .toLocaleLowerCase('pt-BR')
      .includes(search.toLocaleLowerCase('pt-BR')),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 10));
  return (
    <div className="space-y-6">
      <header className="page-heading">
        <div>
          <p className="text-xs font-semibold text-muted-foreground">INTEGRAÇÃO NATIVA</p>
          <h1>Dokploy</h1>
          <p className="text-muted-foreground">
            Descubra aplicações e use backups S3 configurados no Dokploy.
          </p>
        </div>
      </header>
      <aside className="rounded-lg border bg-secondary p-4 text-secondary-foreground">
        O arquivo nativo observado não é um ponto de recuperação verificado pelo APBackup. Bancos e
        arquivos têm restauração independente. Bind mounts não são cobertos pelo backup nativo de
        named volumes.
      </aside>
      {error && (
        <p role="alert" className="rounded-md border border-destructive p-3 text-destructive">
          {error.message}
        </p>
      )}
      <section className="space-y-4 rounded-lg border bg-card p-4">
        <h2 className="text-xl font-semibold">Conectar e descobrir</h2>
        <Label htmlFor="dokploy-connection">Conexão guardada</Label>
        <select
          id="dokploy-connection"
          className="native-select w-full"
          value={connectionId}
          onChange={(e) => {
            setConnectionId(e.target.value);
            discover.reset();
            native.reset();
            setResource(null);
            setPage(1);
          }}
        >
          <option value="">Selecione uma conexão</option>
          {connections.data?.items.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · {c.endpoint}
            </option>
          ))}
        </select>
        {connections.isError && (
          <DataState state="error" onRetry={() => void connections.refetch()} />
        )}
        <div className="flex flex-wrap gap-3">
          <Button
            disabled={!canConfigure || !connectionId || discover.isPending}
            onClick={() => discover.mutate()}
          >
            {discover.isPending ? 'Consultando…' : 'Descobrir recursos'}
          </Button>
          {connection && (
            <a
              href={connection.endpoint}
              target="_blank"
              rel="noopener noreferrer"
              className="self-center text-primary underline"
            >
              Abrir administração nativa
            </a>
          )}
        </div>
        {!canConfigure && (
          <p className="text-sm text-muted-foreground">
            Confirme sua identidade em{' '}
            <Link to="/security" className="underline">
              Segurança
            </Link>{' '}
            para configurar esta integração.
          </p>
        )}
        {canConfigure && (
          <details open={!connections.data?.items.length}>
            <summary className="cursor-pointer font-semibold text-primary">
              Cadastrar conexão Dokploy
            </summary>
            <form
              className="mt-4 grid gap-3"
              onSubmit={form.handleSubmit((value) => create.mutate(value))}
            >
              <Label htmlFor="dokploy-server">Servidor</Label>
              <select id="dokploy-server" className="native-select" {...form.register('serverId')}>
                <option value="">Selecione o servidor</option>
                {servers.data?.items.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
              <Label htmlFor="dokploy-name">Nome</Label>
              <Input id="dokploy-name" {...form.register('name')} />
              <Label htmlFor="dokploy-url">Origem HTTPS aprovada</Label>
              <Input
                id="dokploy-url"
                type="url"
                placeholder="https://dokploy.empresa.com"
                {...form.register('endpoint')}
              />
              <Label htmlFor="dokploy-key">API Key</Label>
              <Input
                id="dokploy-key"
                type="password"
                autoComplete="new-password"
                {...form.register('apiKey')}
              />
              <p className="text-xs text-muted-foreground">
                A chave fica no cofre e não será exibida novamente.
              </p>
              {Object.entries(form.formState.errors).map(([key, value]) => (
                <p key={key} role="alert" className="text-sm text-destructive">
                  {value.message}
                </p>
              ))}
              <Button disabled={create.isPending}>
                {create.isPending ? 'Guardando…' : 'Guardar conexão Dokploy'}
              </Button>
            </form>
          </details>
        )}
      </section>
      {discover.data && (
        <section className="space-y-3 rounded-lg border bg-card p-4">
          <h2 className="text-xl font-semibold">Recursos descobertos</h2>
          <Badge variant="outline">Versão {discover.data.version}</Badge>
          {discover.data.limitations.map((message, i) => (
            <p key={i} className="text-sm text-muted-foreground">
              {message}
            </p>
          ))}
          <Label htmlFor="dokploy-search">Buscar aplicação, projeto ou ambiente</Label>
          <Input
            id="dokploy-search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
          {filtered
            .slice((Math.min(page, pages) - 1) * 10, Math.min(page, pages) * 10)
            .map((item) => (
              <article
                key={item.kind + item.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
              >
                <div className="min-w-0">
                  <h3 className="break-words font-semibold">{item.name}</h3>
                  <p className="text-xs text-muted-foreground">
                    {item.project} · {item.environment} ·{' '}
                    {item.kind === 'postgres'
                      ? 'PostgreSQL'
                      : item.kind === 'compose'
                        ? 'Compose'
                        : 'Aplicação'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {item.mounts.length} montagem(ns) declarada(s)
                  </p>
                </div>
                <Button
                  variant="outline"
                  disabled={!canConfigure || !discover.data?.supported || native.isPending}
                  onClick={() => {
                    setResource(item);
                    native.mutate(item);
                  }}
                >
                  Ver backups configurados
                </Button>
              </article>
            ))}
          {!filtered.length && <DataState state="no-results" />}
          <nav
            aria-label="Paginação dos recursos Dokploy"
            className="flex flex-wrap items-center justify-between gap-2"
          >
            <span className="text-sm">
              {filtered.length} recursos · Página {Math.min(page, pages)} de {pages}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
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
        </section>
      )}
      {resource && (
        <section className="space-y-3 rounded-lg border bg-card p-4">
          <h2 className="text-xl font-semibold">Backups nativos de {resource.name}</h2>
          <p className="text-sm text-muted-foreground">
            Usa configurações S3 existentes. A agenda nativa permanece sob administração do Dokploy;
            evite agendar o mesmo recurso duas vezes.
          </p>
          {native.isPending ? (
            <DataState state="loading" />
          ) : native.isError ? (
            <DataState state="error" onRetry={() => native.mutate(resource)} />
          ) : !native.data?.items.length ? (
            <p role="status">
              Nenhum backup nativo configurado. Prepare um destino S3 e a configuração no Dokploy ou
              utilize os conectores PostgreSQL/Docker do APBackup.
            </p>
          ) : (
            native.data.items.map((item) => (
              <article key={item.kind + item.id} className="space-y-2 rounded-md border p-3">
                <h3 className="font-semibold">{item.name}</h3>
                <p className="break-all text-sm text-muted-foreground">
                  {item.kind === 'volume' ? 'Volume ' + item.volumeName : 'Banco PostgreSQL'} ·
                  Prefixo {item.prefix} ·{' '}
                  {item.enabled ? 'Agenda nativa habilitada' : 'Agenda nativa desabilitada'}
                  {item.turnOff ? ' · Para o serviço durante a captura' : ''}
                </p>
                <Button
                  disabled={!canBackup || run.isPending}
                  onClick={() =>
                    run.mutate({
                      connectionId,
                      kind: item.kind,
                      configurationId: item.id,
                      resourceId: item.resourceId,
                      resourceType: item.resourceType,
                    })
                  }
                >
                  Executar backup nativo
                </Button>
              </article>
            ))
          )}
          <p className="text-sm text-muted-foreground">
            Para voltar uma aplicação sem banco, use{' '}
            <Link to="/docker" className="text-primary underline">
              Docker e arquivos
            </Link>
            . Restaurações nativas não disponíveis por API pública devem ser feitas na administração
            Dokploy.
          </p>
        </section>
      )}
      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Execuções nativas</h2>
        <p className="text-sm text-muted-foreground">
          Arquivo encontrado no destino não comprova integridade nem ensaio de restauração.
        </p>
        {runs.isPending ? (
          <DataState state="loading" />
        ) : runs.isError ? (
          <DataState state="error" onRetry={() => void runs.refetch()} />
        ) : !runs.data?.items.length ? (
          <p className="text-muted-foreground">Nenhuma solicitação registrada.</p>
        ) : (
          runs.data.items.map((item) => (
            <article key={item.id} className="space-y-1 rounded-lg border bg-card p-4">
              <Badge variant="outline">{statusLabels[item.status] ?? 'Em acompanhamento'}</Badge>
              <p className="break-all text-sm">
                {item.selection.resourceId} · {new Date(item.createdAt).toLocaleString('pt-BR')}
              </p>
              <p className="text-xs text-muted-foreground">
                {item.artifacts?.length ?? 0} arquivo(s) observado(s) · Verificação independente
                pendente
              </p>
            </article>
          ))
        )}
      </section>
    </div>
  );
}
